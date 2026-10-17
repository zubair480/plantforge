-- Demo data for the hackathon: one pump and two approved contractors.
-- Replace the technician emails with teammates' real inboxes before the demo.

insert into public.assets (id, name, location, asset_type, scada_tags, flow_min_lpm) values
  ('PUMP-101', 'Raw Water Pump 101', 'Water Treatment Plant A - Intake Building', 'centrifugal_pump',
   '{"flow":"[default]Pump101/Flow","run_cmd":"[default]Pump101/RunCmd","fault":"[default]Pump101/Fault"}'::jsonb,
   50);

insert into public.technicians (name, company, email, trades) values
  ('Alex Rivera', 'Rivera Pump Services', 'contractor1@example.com', '{mechanical,pump}'),
  ('Sam Chen',    'Chen Electrical',      'contractor2@example.com', '{electrical,motor}');
