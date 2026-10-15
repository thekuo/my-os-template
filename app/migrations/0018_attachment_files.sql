-- All chat attachment types (pdf, documents, audio, video, other): original file name and duration (audio/video). Additive.
ALTER TABLE item_attachments ADD COLUMN filename TEXT;
ALTER TABLE item_attachments ADD COLUMN duration REAL;
