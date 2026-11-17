-- A user's computer is now a microVM on a shared host, and what the record
-- keeps is the user's data volume, not an EC2 instance id. The volume outlives
-- every attempt. Rows made for the earlier one-instance-per-user design cannot
-- be used, so they are marked failed and the person presses Try again.
alter table public.vms rename column instance_id to volume_id;
update public.vms set volume_id = null, state = 'failed';
