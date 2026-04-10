CREATE TABLE IF NOT EXISTS drive_attachments (
    id UUID PRIMARY KEY,
    drive_file_id TEXT NOT NULL CHECK (btrim(drive_file_id) <> ''),
    drive_folder_id TEXT,
    file_name TEXT,
    mime_type TEXT,
    web_view_link TEXT,
    web_content_link TEXT,
    knowledge_entry_id UUID REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'google_drive' CHECK (btrim(source) <> ''),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        knowledge_entry_id IS NOT NULL
        OR property_id IS NOT NULL
        OR entity_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_drive_attachments_file
    ON drive_attachments (drive_file_id);

CREATE INDEX IF NOT EXISTS idx_drive_attachments_entity
    ON drive_attachments (entity_id);

CREATE INDEX IF NOT EXISTS idx_drive_attachments_property
    ON drive_attachments (property_id);

CREATE INDEX IF NOT EXISTS idx_drive_attachments_knowledge
    ON drive_attachments (knowledge_entry_id);
