-- Add temperature and city columns to photo_pins
alter table photo_pins add column if not exists temperature text;
alter table photo_pins add column if not exists city text;
