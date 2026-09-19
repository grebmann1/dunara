-- Bucket lifecycle is configured through Builder's Storage API operation.
-- Review and apply these policies separately in the app database.
begin;
create policy builder_uploads_read on storage.objects for select to authenticated
  using (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy builder_uploads_create on storage.objects for insert to authenticated
  with check (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy builder_uploads_update on storage.objects for update to authenticated
  using (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy builder_uploads_delete on storage.objects for delete to authenticated
  using (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
commit;
