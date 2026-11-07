-- A stored policy only: third-party VPN data-plane metering is not available.
-- Existing users remain unlimited and no usage data is fabricated.
ALTER TABLE users ADD COLUMN traffic_limit_bytes bigint CHECK (traffic_limit_bytes >= 0 AND traffic_limit_bytes <= 9007199254740991);
