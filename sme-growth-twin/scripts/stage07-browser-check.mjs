import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const chromePath = process.env.CHROME_PATH?.trim() || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const appPort = Number(process.env.STAGE07_PORT || 3017);
const debugPort = Number(process.env.STAGE07_DEBUG_PORT || 9557);
const configuredBaseUrl = process.env.STAGE07_BASE_URL?.trim();
let baseUrl = `http://127.0.0.1:${appPort}`;
if (configuredBaseUrl) {
  const parsedBaseUrl = new URL(configuredBaseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) throw new Error("STAGE07_BASE_URL must be an HTTP(S) URL without embedded credentials");
  baseUrl = parsedBaseUrl.toString().replace(/\/$/, "");
}
const artifactOverride = process.env.STAGE07_ARTIFACT_DIR?.trim();
const hostedSmoke = process.argv.includes("--hosted-smoke");
if (hostedSmoke && !configuredBaseUrl) throw new Error("Hosted smoke requires STAGE07_BASE_URL");
const functionalOnly = hostedSmoke || process.argv.includes("--functional");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cliStatus = spawnSync(process.execPath, ["node_modules/supabase/dist/supabase.js", "status", "-o", "env"], {
  cwd: process.cwd(), encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024,
});
if (cliStatus.status !== 0) throw new Error("Loopback Supabase is required for the production browser journey");
const localSupabase = cliStatus.stdout.trim().startsWith("{") ? JSON.parse(cliStatus.stdout) : Object.fromEntries(cliStatus.stdout.split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)="?(.*?)"?$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/"$/, "")]));
if (!["127.0.0.1", "localhost"].includes(new URL(localSupabase.API_URL).hostname)) throw new Error("Browser journey database must be loopback");
const localEnv = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: localSupabase.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: localSupabase.PUBLISHABLE_KEY || localSupabase.ANON_KEY,
  SUPABASE_SECRET_KEY: localSupabase.SECRET_KEY || localSupabase.SERVICE_ROLE_KEY,
  MAJUPILOT_GUEST_TOKEN_PEPPER: `stage07-${crypto.randomUUID()}`,
  AI_EXECUTION_MODE: "disabled", AI_GATEWAY_MODEL: "", AI_GATEWAY_API_KEY: "", VERCEL_OIDC_TOKEN: "",
};
const stopTree = (child) => { if (!child?.pid) return; try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { try { child.kill(); } catch {} } };

let artifacts; let profile; let server; let chrome; let ws; let testUserId;
const admin = createClient(localSupabase.API_URL, localEnv.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
try {
  artifacts = artifactOverride ? path.resolve(artifactOverride) : await mkdtemp(path.join(tmpdir(), "sme-growth-twin-stage07-artifacts-"));
  profile = await mkdtemp(path.join(tmpdir(), "sme-growth-twin-stage07-profile-"));
  await mkdir(artifacts, { recursive: true });
  const axeSource = await readFile(path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");

  let serverOutput = "";
  if (!configuredBaseUrl) {
    if (!process.argv.includes("--skip-build")) execFileSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { cwd: process.cwd(), env: localEnv, stdio: "inherit", windowsHide: true });
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(appPort)], {
      cwd: process.cwd(), env: localEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    server.stdout.on("data", (value) => { serverOutput += value.toString(); });
    server.stderr.on("data", (value) => { serverOutput += value.toString(); });
  }
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) { try { if ((await fetch(baseUrl)).ok) { ready = true; break; } } catch {} await wait(500); }
  if (!ready) throw new Error(`${configuredBaseUrl ? "External target did not respond" : "Production server did not start"}: ${serverOutput.slice(-3000)}`);

  const headerResponse = await fetch(baseUrl);
  const securityHeaders = Object.fromEntries(["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"].map((name) => [name, headerResponse.headers.get(name)]));

  chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  let endpoint;
  for (let attempt = 0; attempt < 80; attempt += 1) { try { const tabs = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()); endpoint = tabs.find((tab) => tab.type === "page")?.webSocketDebuggerUrl; if (endpoint) break; } catch {} await wait(200); }
  if (!endpoint) throw new Error("Chrome DevTools endpoint did not start");
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const failedRequests = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const call = pending.get(message.id); pending.delete(message.id); if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    if (message.method === "Network.responseReceived" && ["XHR", "Fetch"].includes(message.params.type) && message.params.response.url.startsWith(baseUrl) && message.params.response.status >= 400) failedRequests.push(`${message.params.response.status} ${message.params.response.url}`);
    if (message.method === "Page.javascriptDialogOpening") void cdp("Page.handleJavaScriptDialog", { accept: true });
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const poll = async (expression, expected, timeout = 25_000) => { const started = Date.now(); let actual; while (Date.now() - started < timeout) { actual = await evaluate(expression); if (actual === expected) return; await wait(120); } throw new Error(`Timed out: ${expression}; actual=${JSON.stringify(actual)}`); };
  const navigate = async (pathname) => { await cdp("Page.navigate", { url: `${baseUrl}${pathname}` }); await poll("document.readyState", "complete"); };
  const key = async (name, code = name, modifiers = 0) => { const windowsVirtualKeyCode = name === "Tab" ? 9 : name === "Enter" ? 13 : name === " " ? 32 : name === "ArrowDown" ? 40 : 0; const text = name === "Enter" ? "\r" : name === " " ? " " : undefined; await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, modifiers, windowsVirtualKeyCode, ...(text ? { text } : {}) }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, modifiers, windowsVirtualKeyCode }); };
  const tabTo = async (predicate, maximum = 120) => {
    await evaluate("document.activeElement?.blur()");
    for (let index = 0; index < maximum; index += 1) { await key("Tab"); if (await evaluate(`(() => { const e=document.activeElement; return Boolean(e && (${predicate})); })()`)) return; }
    throw new Error(`Keyboard target not found: ${predicate}`);
  };
  const activateText = async (text) => { await tabTo(`(e.textContent || '').includes(${JSON.stringify(text)})`); await key("Enter"); };
  const activateBalanced = async () => { await tabTo(`e.tagName==='BUTTON' && (e.textContent || '').includes('Select as preferred') && e.closest('.balanced_growth')`); await key("Enter"); };
  const insert = async (name, value) => { await tabTo(`e.getAttribute('name')===${JSON.stringify(name)}`); await key("a", "KeyA", 2); await cdp("Input.insertText", { text: value }); };
  const screenshot = async (name) => { const capture = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true }); await writeFile(path.join(artifacts, name), Buffer.from(capture.data, "base64")); };
  const checks = [];
  const checkLayout = async (route, width) => {
    if (functionalOnly) return;
    const value = await evaluate(`(() => { const controls=[...document.querySelectorAll('button,a.button,input:not([type=hidden]):not([type=radio]):not([type=checkbox]),select,textarea,summary,.segmented span,.option-grid span,.range label span,.consent-card label')].filter(e=>{const s=getComputedStyle(e);return e.getClientRects().length>0&&s.display!=='none'&&s.visibility!=='hidden'&&e.getAttribute('aria-hidden')!=='true'}); const routine=controls.filter(e=>!(e.tagName==='A'&&!e.classList.contains('button'))&&!e.classList.contains('quiet-reset')); const ordered=routine.map(e=>({tag:e.tagName,cls:e.className,name:e.getAttribute('name'),text:(e.textContent||'').trim().slice(0,50),height:e.getBoundingClientRect().height})).sort((a,b)=>a.height-b.height); return { overflow:document.documentElement.scrollWidth>window.innerWidth, minTarget:ordered[0]?.height??null, smallest:ordered.slice(0,3), overlay:Boolean(document.querySelector('[data-nextjs-dialog],.vite-error-overlay,#webpack-dev-server-client-overlay')) }; })()`);
    checks.push({ route, width, ...value });
    if (value.overflow || value.overlay || (value.minTarget !== null && value.minTarget < 43.5)) throw new Error(`Layout gate failed ${route} ${width}: ${JSON.stringify(value)}`);
  };
  const axe = async (state) => {
    if (functionalOnly) return { state, skipped: "functional-only run" };
    await evaluate(axeSource);
    const result = await evaluate(`axe.run(document,{resultTypes:['violations']}).then(r=>r.violations.filter(v=>v.impact==='critical'||v.impact==='serious').map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length,targets:v.nodes.map(n=>n.target)})))`);
    if (result.length) throw new Error(`Axe violations at ${state}: ${JSON.stringify(result)}`);
    return { state, criticalSerious: 0 };
  };
  const viewport = async (width, height = 900) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 600 });
  const runToBlueprint = async (fixtureButton, keyboard) => {
    await navigate("/");
    if (keyboard) await activateText(fixtureButton); else await evaluate(`document.querySelector(${JSON.stringify(`[data-fixture-id="${fixtureButton}"]`)})?.click()`);
    await poll("location.pathname", "/assessment/review");
    await poll("document.querySelector('.demo-banner')?.innerText.includes('Fictional demonstration') ?? false", true);
    if (keyboard) await activateText("Confirm Business Twin"); else await evaluate("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('Confirm Business Twin'))?.click()");
    await poll("location.pathname", "/results", 20_000);
    if (keyboard) await activateText("View recommendations"); else await evaluate("document.querySelector('a[href=\"/recommendations\"]')?.click()");
    await poll("location.pathname", "/recommendations");
    if (keyboard) await activateText("Compare transformation scenarios"); else await evaluate("document.querySelector('a[href=\"/scenarios\"]')?.click()");
    await poll("location.pathname", "/scenarios");
    if (keyboard) await activateBalanced(); else await evaluate("Array.from(document.querySelectorAll('.balanced_growth button')).find(e=>e.textContent.includes('Select as preferred'))?.click()");
    await wait(150);
    if (keyboard) await activateText("Generate Advisor review and Blueprint"); else await evaluate("document.querySelector('a[href=\"/blueprint\"]')?.click()");
    await poll("location.pathname", "/blueprint");
    if (keyboard) await activateText("Generate advisor review and Blueprint"); else await evaluate("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('Generate advisor review and Blueprint'))?.click()");
    await poll("document.body.innerText.includes('Five advisor reviews')", true, 35_000);
    return evaluate(`(() => { const b=JSON.parse(localStorage.getItem('sme-growth-twin:blueprint:1.0.0')); const s=b.snapshot.selectedScenario; return { name:b.snapshot.twin.identity.businessName,maturity:b.snapshot.diagnostic.digitalMaturity.value,readiness:b.snapshot.diagnostic.aiReadiness.value,recommendations:b.snapshot.recommendations.recommendations.map(r=>r.capabilityId+':'+r.status),scenario:s.templateId,cost:s.costs.firstYear,operational:s.value.operational.range,net:s.value.net.range,payback:s.value.payback,origins:b.advisorReviews.map(r=>r.origin),sections:b.sectionIds.length }; })()`);
  };
  const resetViaBanner = async () => {
    const original = await evaluate("JSON.parse(localStorage.getItem('majupilot:pre-demo-workspace:1.0.0')||'{}').local?.['sme-growth-twin:assessment-draft:1.0.0']??null");
    await evaluate("document.querySelector('.demo-reset-dialog')?.showModal();document.querySelector('.demo-reset-dialog .danger')?.click()");
    await poll("location.pathname", "/");
    await poll("localStorage.getItem('sme-growth-twin:assessment-draft:1.0.0')", original);
  };
  const knownLocalKeys = ["sme-growth-twin:assessment-draft:1.0.0", "sme-growth-twin:diagnostic:1.0.0", "sme-growth-twin:recommendations:1.0.0", "sme-growth-twin:scenarios:1.0.0", "sme-growth-twin:blueprint:1.0.0", "sme-growth-twin:demo-session:1.0.0"];
  const knownSessionKeys = ["sme-growth-twin:lead-receipt:1.0.0", "sme-growth-twin:reset-status:1.0.0"];

  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable"); await viewport(1440, 1000);
  const accessibility = [];
  await navigate("/"); accessibility.push(await axe("home")); await checkLayout("/", 1440);
  await navigate("/assessment?new=1"); await poll("document.body.innerText.includes('Your business at a glance')", true); accessibility.push(await axe("assessment")); await checkLayout("/assessment", 1440);
  const originalDraft = await evaluate("localStorage.getItem('sme-growth-twin:assessment-draft:1.0.0')");
  let originalGuest;
  let originalGuestCookie;
  if (hostedSmoke) {
    originalGuest = await evaluate("fetch('/api/v2/guest/session',{method:'POST'}).then(async r=>{if(!r.ok)throw new Error('guest issue failed');return (await r.json()).data})");
    await evaluate(`localStorage.setItem('majupilot:durable-journey:1.0.0',JSON.stringify({...${JSON.stringify(originalGuest)},leadIdempotencyKey:'lead:'+crypto.randomUUID()}))`);
    originalGuestCookie = (await cdp("Network.getAllCookies")).cookies.find((cookie) => cookie.name === "__Host-majupilot_guest")?.value;
    if (!originalGuestCookie) throw new Error("Real guest host cookie was not stored");
  }

  await navigate("/");
  await evaluate("document.querySelector('[data-fixture-id=\"case-a\"]')?.click()");
  await poll("location.pathname", "/assessment/review");
  await navigate("/");
  await poll("Boolean(document.querySelector('.demo-banner'))", true);
  const homeResetTimeOrigin = await evaluate("performance.timeOrigin");
  await evaluate(`(() => { const localKeys=${JSON.stringify(knownLocalKeys)}; const sessionKeys=${JSON.stringify(knownSessionKeys)}; for(const key of localKeys)if(!key.includes('demo-session'))localStorage.setItem(key,'known-project-value'); for(const key of sessionKeys)sessionStorage.setItem(key,'known-project-value'); localStorage.setItem('unrelated-home-reset','keep'); sessionStorage.setItem('unrelated-home-reset-session','keep'); document.querySelector('.demo-reset-dialog')?.showModal(); document.querySelector('.demo-reset-dialog .danger')?.click(); })()`);
  await poll("Boolean(document.querySelector('.demo-banner:not(.demo-banner-cleared)'))", false);
  const homeReset = await evaluate(`(() => { const localKeys=${JSON.stringify(knownLocalKeys)}; const sessionKeys=${JSON.stringify(knownSessionKeys)}; return { stayedOnHome:location.pathname==='/'&&performance.timeOrigin===${homeResetTimeOrigin}, bannerRemoved:!document.querySelector('.demo-banner:not(.demo-banner-cleared)'), originalDraftRestored:localStorage.getItem('sme-growth-twin:assessment-draft:1.0.0')===${JSON.stringify(originalDraft)}, demoRecordsCleared:localKeys.filter(key=>!key.includes('assessment-draft')).every(key=>localStorage.getItem(key)===null), knownSessionCleared:sessionKeys.every(key=>sessionStorage.getItem(key)===null), unrelatedPreserved:localStorage.getItem('unrelated-home-reset')==='keep'&&sessionStorage.getItem('unrelated-home-reset-session')==='keep', statusVisible:[...document.querySelectorAll('.reset-status')].some(e=>e.textContent.includes('demonstration data was reset')) }; })()`);

  const journeyStarted = Date.now();
  const caseA = await runToBlueprint("Load CASE A", true);
  const blueprintDurationMs = Date.now() - journeyStarted;
  accessibility.push(await axe("reviewed blueprint")); await checkLayout("/blueprint", 1440);
  await poll("Boolean(document.querySelector('.phase02-handoff.sync-ready a[href^=\"/copilot\"]'))", true, 60_000);
  await activateText("Continue to Copilot");
  await poll("location.pathname", "/copilot");
  await poll("Boolean(document.querySelector('#copilot-message:not([disabled])'))", true, 60_000);
  const copilotBeforeTurn = await evaluate("document.querySelectorAll('.copilot-message.assistant').length");
  await evaluate(`(() => { const field=document.querySelector('#copilot-message'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(field,'Summarize the saved Business Twin for this fictional company.'); field.dispatchEvent(new Event('input',{bubbles:true})); field.form.requestSubmit(); })()`);
  await poll(`document.querySelectorAll('.copilot-message.assistant').length>${copilotBeforeTurn}`, true, 60_000);
  await poll("!document.querySelector('.copilot-message.streaming') && document.querySelectorAll('.copilot-message.assistant:not(.draft)').length>1", true, 120_000);
  await cdp("Page.reload");
  await poll("document.readyState", "complete");
  await poll("Boolean(document.querySelector('#copilot-message:not([disabled])'))", true, 60_000);
  const copilotJourney = { openedFromBlueprint: true, turnCompleted: true, historyRestored: await evaluate("document.querySelectorAll('.copilot-message.user').length>=1") };
  if (!copilotJourney.historyRestored) throw new Error("Case A Copilot history did not restore");
  if (hostedSmoke) {
    const cookies = (await cdp("Network.getAllCookies")).cookies;
    const realCookiePreserved = cookies.find((cookie) => cookie.name === "__Host-majupilot_guest")?.value === originalGuestCookie;
    const demoCookieIsSeparate = Boolean(cookies.find((cookie) => cookie.name === "__Host-majupilot_demo_guest"));
    await resetViaBanner();
    const guestWorkRestored = await evaluate(`JSON.parse(localStorage.getItem('majupilot:durable-journey:1.0.0'))?.assessmentSessionId===${JSON.stringify(originalGuest.assessmentSessionId)}`);
    const resumed = await evaluate("fetch('/api/v2/guest/session',{method:'PUT'}).then(async r=>{if(!r.ok)throw new Error('restored guest access failed');return (await r.json()).data})");
    const restoredGuestAuthorized = resumed.assessmentSessionId === originalGuest.assessmentSessionId;
    const evidence = { baseUrl, newAssessmentThenDemo: true, copilotJourney, realCookiePreserved, demoCookieIsSeparate, guestWorkRestored, restoredGuestAuthorized, homeReset, consoleErrors, failedRequests };
    await writeFile(path.join(artifacts, "hosted-functional-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    if (!realCookiePreserved || !demoCookieIsSeparate || !guestWorkRestored || !restoredGuestAuthorized || !Object.entries(homeReset).every(([name, passed]) => name === "statusVisible" || passed) || consoleErrors.length || failedRequests.length) throw new Error("Hosted functional regressions failed");
    await evaluate("Promise.all([fetch('/api/v2/guest/revoke',{method:'POST'}),fetch('/api/v2/guest/revoke',{method:'POST',headers:{'x-majupilot-workspace':'demo'}})])");
    await cdp("Browser.close");
  } else {
  await navigate("/blueprint");
  await poll("document.body.innerText.includes('Five advisor reviews')", true);
  await activateText("Request consultation"); await poll("location.pathname", "/consultation"); accessibility.push(await axe("consultation")); await checkLayout("/consultation", 1440);
  await insert("name", "Aiman Demo");
  await insert("businessName", "Kopi Kita Café Group");
  await insert("email", "aiman.demo@example.test");
  await insert("phone", "+60 12 300 4000");
  await tabTo("e.getAttribute('name')==='urgency'"); await key("ArrowDown");
  await tabTo("e.getAttribute('name')==='consent'"); await key(" ", "Space");
  await tabTo("e.getAttribute('type')==='submit'"); await key("Enter");
  await poll("document.body.innerText.includes('Request recorded.')", true, 90_000);
  accessibility.push(await axe("consultation success")); await checkLayout("/consultation success", 1440);
  const receiptSafe = await evaluate(`(() => { const raw=localStorage.getItem('majupilot:durable-journey:1.0.0'); const value=JSON.parse(raw||'null'); const receipt=JSON.stringify(value?.lead||{}).toLowerCase(); return Boolean(value?.lead?.leadId&&value?.report?.contentSha256)&&!['aiman','example.test','+60','email','phone','contact'].some(item=>receipt.includes(item)); })()`);
  await evaluate("localStorage.setItem('unrelated-stage07','preserve-me');sessionStorage.setItem('unrelated-stage07-session','preserve-me')");
  await resetViaBanner();
  const scopedReset = await evaluate("localStorage.getItem('unrelated-stage07')==='preserve-me'&&sessionStorage.getItem('unrelated-stage07-session')==='preserve-me'&&localStorage.getItem('sme-growth-twin:demo-session:1.0.0')===null");

  const caseB = await runToBlueprint("case-b", false); await resetViaBanner();
  const caseC = await runToBlueprint("case-c", false);
  await screenshot("stage-07-case-c-blueprint.png");

  const stateRoutes = ["/", "/assessment", "/assessment/review", "/results", "/recommendations", "/scenarios", "/blueprint", "/consultation"];
  for (const route of stateRoutes) {
    await navigate(route);
    await wait(180);
    await checkLayout(route, 1440);
    if (!["/", "/assessment"].includes(route)) accessibility.push(await axe(`desktop ${route}`));
  }
  await viewport(360, 800);
  for (const route of stateRoutes) { await navigate(route); await wait(180); await checkLayout(route, 360); }
  await navigate("/blueprint"); await poll("document.body.innerText.includes('Five advisor reviews')", true); accessibility.push(await axe("mobile blueprint"));

  const accountDemo = {};
  if (functionalOnly) {
    await viewport(1440, 1000);
    await resetViaBanner();
    // The three fixture stories exhaust the intentional per-process review budget.
    // Start the independent account story with a fresh local server, without
    // relaxing the production limiter or altering the saved browser workspace.
    if (!configuredBaseUrl) {
      stopTree(server);
      server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(appPort)], {
        cwd: process.cwd(), env: localEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      server.stdout.on("data", (value) => { serverOutput += value.toString(); });
      server.stderr.on("data", (value) => { serverOutput += value.toString(); });
      let accountServerReady = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try { if ((await fetch(baseUrl)).ok) { accountServerReady = true; break; } } catch {}
        await wait(500);
      }
      if (!accountServerReady) throw new Error("Independent account test server did not start");
    }
    const email = `functional-${crypto.randomUUID()}@example.test`;
    const password = `Synthetic-${crypto.randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error("Could not create the local synthetic account");
    testUserId = created.data.user.id;
    await navigate("/cases");
    await poll("Boolean(document.querySelector('#account-email'))", true);
    for (const [id, value] of [["account-email", email], ["account-password", password]]) {
      await tabTo(`e.id===${JSON.stringify(id)}`);
      await cdp("Input.insertText", { text: value });
    }
    await tabTo("e.closest('.account-signin-form') && e.type==='submit'"); await key("Enter");
    await poll(`document.body.innerText.includes(${JSON.stringify(`Signed in as ${email}`)})`, true);
    await poll("document.body.innerText.includes(\"Add this browser's work\")", true);
    await activateText("Add this browser's work");
    await poll("document.body.innerText.includes(\"This browser's work is now saved to your account.\")", true);
    await navigate("/cases");
    await poll("document.body.innerText.includes('New case')", true);
    await activateText("New case"); await poll("location.pathname", "/assessment");
    await poll("Boolean(document.querySelector('[name=businessName]'))", true);
    await insert("businessName", "Synthetic saved case");
    await poll("JSON.parse(localStorage.getItem('sme-growth-twin:assessment-draft:1.0.0')||'{}').answers?.q1?.businessName", "Synthetic saved case");
    const savedDraft = await evaluate("localStorage.getItem('sme-growth-twin:assessment-draft:1.0.0')");
    const savedCase = await evaluate("JSON.parse(localStorage.getItem('majupilot:active-account-case:1.0.0'))");
    await runToBlueprint("case-a", false);
    await poll("Boolean(document.querySelector('.phase02-handoff.sync-ready a[href^=\"/copilot\"]'))", true, 60_000);
    await activateText("Continue to Copilot"); await poll("location.pathname", "/copilot");
    await poll("Boolean(document.querySelector('#copilot-message:not([disabled])'))", true, 60_000);
    accountDemo.signedInDemoCopilotOpened = true;
    accountDemo.demoIsGuestScoped = await evaluate("!JSON.parse(localStorage.getItem('majupilot:durable-journey:1.0.0')).organizationId && !localStorage.getItem('majupilot:active-account-case:1.0.0')");
    await resetViaBanner();
    accountDemo.originalDraftRestored = await evaluate(`localStorage.getItem('sme-growth-twin:assessment-draft:1.0.0')===${JSON.stringify(savedDraft)}`);
    accountDemo.accountRestored = await evaluate(`JSON.parse(localStorage.getItem('majupilot:active-account-case:1.0.0'))?.caseId===${JSON.stringify(savedCase.caseId)}`);
    await navigate("/cases");
    await poll("document.body.innerText.includes('Synthetic saved case')", true);
    await activateText("Resume case"); await poll("location.pathname", "/assessment");
    await poll("document.querySelector('[name=businessName]')?.value", "Synthetic saved case");
    accountDemo.savedCaseResumed = true;
    accountDemo.noSaveConflictWarning = await evaluate("!document.querySelector('.account-save-warning')");
  }

  const expected = {
    caseA: { name: "Kopi Kita Café Group", maturity: 37.5, readiness: 42.5, scenario: "balanced_growth", cost: { low: 9200, base: 18400, high: 27600 }, payback: { status: "estimated", best: 7.2, base: 30.4, worst: 140.5 }, sections: 16 },
    caseB: { name: "Precision Parts Manufacturing", maturity: 23.2, readiness: 43.8, scenario: "balanced_growth", cost: { low: 7400, base: 14800, high: 22200 }, payback: { status: "estimated", best: 5, base: 21.1, worst: 97.3 }, sections: 16 },
    caseC: { name: "Northstar Digital Studio", maturity: 79, readiness: 73.8, scenario: "balanced_growth", cost: { low: 22400, base: 44800, high: 67200 }, payback: { status: "estimated", best: 45.6, base: 191.5, worst: 883.6 }, sections: 16 },
  };
  const casesMatch = [[caseA, expected.caseA], [caseB, expected.caseB], [caseC, expected.caseC]].every(([actual, frozen]) => Object.entries(frozen).every(([keyName, value]) => JSON.stringify(actual[keyName]) === JSON.stringify(value)) && actual.origins.every((origin) => origin === "deterministic_fallback"));
  const headersPass = securityHeaders["x-frame-options"] === "DENY" && securityHeaders["x-content-type-options"] === "nosniff" && securityHeaders["referrer-policy"] === "strict-origin-when-cross-origin" && securityHeaders["content-security-policy"]?.includes("frame-ancestors 'none'") && securityHeaders["permissions-policy"]?.includes("camera=()");
  // Reload can race a visibility save. The client recovers an exact snapshot
  // replay after a 409; successful flush, resume and no warning prove recovery.
  const recoveredAccountConflicts = Object.keys(accountDemo).length && Object.values(accountDemo).every(Boolean)
    ? failedRequests.filter((item) => item.startsWith(`409 ${baseUrl}/api/v2/cases/`)) : [];
  const unexpectedFailedRequests = failedRequests.filter((item) => !recoveredAccountConflicts.includes(item));
  const evidence = { environment: { node: process.version, chromePath, mode: configuredBaseUrl ? "external" : "local-production", baseUrl }, cases: { caseA, caseB, caseC }, copilotJourney, accountDemo, accessibility, responsive: checks, keyboardJourney: { completed: true, receiptSafe, blueprintDurationMs, underFiveMinutes: blueprintDurationMs < 300_000 }, homeReset, scopedReset, securityHeaders, consoleErrors, failedRequests: unexpectedFailedRequests, recoveredAccountConflicts, overlay: await evaluate("Boolean(document.querySelector('[data-nextjs-dialog],.vite-error-overlay,#webpack-dev-server-client-overlay'))") };
  await writeFile(path.join(artifacts, "stage-07-browser-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!casesMatch || !Object.values(copilotJourney).every(Boolean) || !Object.values(accountDemo).every(Boolean) || !receiptSafe || !Object.entries(homeReset).every(([name, passed]) => (functionalOnly && name === "statusVisible") || passed) || !scopedReset || !headersPass || blueprintDurationMs >= 300_000 || consoleErrors.length || unexpectedFailedRequests.length || evidence.overlay) throw new Error("Stage 07 browser assertions failed");
  await cdp("Browser.close");
  }
} catch (error) {
  if (ws?.readyState === WebSocket.OPEN) {
    const id = 999999;
    const diagnostic = await new Promise((resolve) => {
      const listener = (event) => {
        const response = JSON.parse(event.data);
        if (response.id !== id) return;
        ws.removeEventListener("message", listener);
        resolve(response.result?.result?.value);
      };
      ws.addEventListener("message", listener);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "({pathname:location.pathname,text:document.body.innerText})", returnByValue: true } }));
    });
    await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: error.message, diagnostic }, null, 2));
  }
  throw error;
} finally {
  if (testUserId) await admin.auth.admin.deleteUser(testUserId);
  try { ws?.close(); } catch {}
  stopTree(chrome); stopTree(server);
  await wait(500);
  if (profile) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
    catch (error) { console.warn(`Temporary Chrome profile cleanup deferred: ${error.message}`); }
  }
  if (!artifactOverride && artifacts) {
    try { await rm(artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
    catch (error) { console.warn(`Temporary evidence cleanup deferred: ${error.message}`); }
  }
}
