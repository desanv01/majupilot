begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('91000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','storage-scope@example.invalid','',now(),now(),now());
insert into public.organizations(id,display_name) values('92000000-0000-4000-8000-000000000001','Storage regression');
insert into public.organization_members(organization_id,user_id,role,status)
values('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','prospect','active');
insert into storage.objects(bucket_id,name) values
('majupilot-reports','92000000-0000-4000-8000-000000000001/regression/report.pdf'),
('majupilot-exports','92000000-0000-4000-8000-000000000001/regression/export.json'),
('majupilot-reports','guest/93000000-0000-4000-8000-000000000001/regression/report.pdf'),
('majupilot-reports','malformed/regression/report.pdf'),
('majupilot-exports','guest/93000000-0000-4000-8000-000000000001/regression/export.json');

select is(app_private.storage_organization_id('guest/any/report.pdf'),null::uuid,'guest paths have no account scope');
select is(app_private.storage_organization_id('malformed/report.pdf'),null::uuid,'malformed paths have no account scope');
select is(app_private.storage_organization_id('92000000-0000-4000-8000-000000000001'),null::uuid,'a root filename is not an organization folder');
select is(app_private.storage_organization_id('92000000-0000-4000-8000-000000000001/report.pdf'),'92000000-0000-4000-8000-000000000001'::uuid,'account scope is preserved');
select set_config('request.jwt.claims','{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*)::integer from storage.objects where bucket_id='majupilot-reports'),1,'guest reports do not break authorized report listing');
select is((select count(*)::integer from storage.objects where bucket_id='majupilot-exports'),1,'guest exports do not break authorized export listing');
select is((select count(*)::integer from storage.objects where name like 'guest/%' or name like 'malformed/%'),0,'guest and malformed files remain private');
select throws_ok($$insert into storage.objects(bucket_id,name) values('majupilot-reports','guest/injected/report.pdf')$$,'42501',null,'signed-in members cannot insert into guest paths');
select throws_ok($$insert into storage.objects(bucket_id,name) values('majupilot-exports','malformed/injected/export.json')$$,'42501',null,'malformed exports are denied without invalid UUID errors');
reset role;
set local role anon;
select is((select count(*)::integer from storage.objects),0,'anonymous users cannot see private files');
reset role;
select * from finish();
rollback;
