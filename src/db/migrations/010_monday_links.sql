CREATE TABLE IF NOT EXISTS monday_links (
    entity_id UUID NOT NULL,
    monday_board_id TEXT NOT NULL CHECK (btrim(monday_board_id) <> ''),
    monday_item_id TEXT NOT NULL CHECK (btrim(monday_item_id) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity_id, monday_board_id, monday_item_id)
);

CREATE INDEX IF NOT EXISTS idx_monday_links_item
    ON monday_links (monday_item_id);

CREATE INDEX IF NOT EXISTS idx_monday_links_board
    ON monday_links (monday_board_id);
