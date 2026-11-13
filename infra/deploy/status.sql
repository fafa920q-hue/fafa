SELECT json_build_object(
 'ownerInitialized',(SELECT closed FROM owner_initialization WHERE singleton),
 'ownerCount',(SELECT count(*) FROM users WHERE role='Owner' AND deleted_at IS NULL),
 'userCount',(SELECT count(*) FROM users WHERE deleted_at IS NULL),
 'activeNodeCount',(SELECT count(*) FROM nodes WHERE revoked_at IS NULL),
 'workerHeartbeatFresh',coalesce((SELECT updated_at>now()-interval '30 seconds' FROM settings WHERE key='worker_heartbeat'),false)
);
