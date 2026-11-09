-- Legacy API and worker use only secret. Keep Claude credentials inaccessible to them.
ALTER TABLE ai_accounts ADD COLUMN anthropic_secret jsonb;
ALTER TABLE ai_accounts ADD CONSTRAINT ai_accounts_provider_credential_check
  CHECK (
    (data->>'provider' IS NOT DISTINCT FROM 'ANTHROPIC_API' AND secret IS NULL)
    OR (data->>'provider' IS DISTINCT FROM 'ANTHROPIC_API' AND anthropic_secret IS NULL)
  );
