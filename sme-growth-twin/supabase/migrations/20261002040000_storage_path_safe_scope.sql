begin;

-- Guest reports and private evidence share storage.objects with organization
-- files. Their non-UUID prefixes must deny access rather than abort RLS queries.
create or replace function app_private.storage_organization_id(object_name text)
returns uuid language plpgsql immutable strict set search_path = pg_catalog as $$
begin
  if strpos(object_name, '/') = 0 then return null; end if;
  return split_part(object_name, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;
revoke all on function app_private.storage_organization_id(text) from public;
grant execute on function app_private.storage_organization_id(text) to authenticated;

alter policy report_objects_select on storage.objects
  using(bucket_id='majupilot-reports' and app_private.is_active_member(app_private.storage_organization_id(name),null));
alter policy report_objects_insert on storage.objects
  with check(bucket_id='majupilot-reports' and app_private.is_active_member(app_private.storage_organization_id(name),null));
alter policy report_objects_update on storage.objects
  using(bucket_id='majupilot-reports' and app_private.is_active_member(app_private.storage_organization_id(name),null))
  with check(bucket_id='majupilot-reports' and app_private.is_active_member(app_private.storage_organization_id(name),null));
alter policy report_objects_delete on storage.objects
  using(bucket_id='majupilot-reports' and app_private.is_active_member(app_private.storage_organization_id(name),array['sales_manager','system_admin']::public.organization_role[]));
alter policy export_objects_select on storage.objects
  using(bucket_id='majupilot-exports' and app_private.is_active_member(app_private.storage_organization_id(name),null));
alter policy export_objects_insert on storage.objects
  with check(bucket_id='majupilot-exports' and app_private.is_active_member(app_private.storage_organization_id(name),array['sales_manager','system_admin']::public.organization_role[]));
alter policy export_objects_update on storage.objects
  using(bucket_id='majupilot-exports' and app_private.is_active_member(app_private.storage_organization_id(name),array['sales_manager','system_admin']::public.organization_role[]))
  with check(bucket_id='majupilot-exports' and app_private.is_active_member(app_private.storage_organization_id(name),array['sales_manager','system_admin']::public.organization_role[]));
alter policy export_objects_delete on storage.objects
  using(bucket_id='majupilot-exports' and app_private.is_active_member(app_private.storage_organization_id(name),array['sales_manager','system_admin']::public.organization_role[]));

commit;
