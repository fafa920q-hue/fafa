CREATE UNIQUE INDEX unique_active_owner ON users ((true)) WHERE role='Owner' AND deleted_at IS NULL;
CREATE TABLE owner_initialization (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 owner_id uuid REFERENCES users(id), google_sub text REFERENCES google_identities(sub),
 completed_at timestamptz, closed boolean NOT NULL DEFAULT false
);
INSERT INTO owner_initialization(singleton) VALUES (true);
UPDATE owner_initialization SET owner_id=u.id,google_sub=(SELECT g.sub FROM google_identities g WHERE g.user_id=u.id ORDER BY g.created_at LIMIT 1),completed_at=now(),closed=true
FROM users u WHERE u.role='Owner' AND u.deleted_at IS NULL;
CREATE FUNCTION keep_owner_initialization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.closed THEN RAISE EXCEPTION 'owner initialization permanently closed'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'owner initialization cannot be deleted'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_initialization_immutable BEFORE UPDATE OR DELETE ON owner_initialization FOR EACH ROW EXECUTE FUNCTION keep_owner_initialization();
CREATE TABLE owner_setup_credentials (
 id uuid PRIMARY KEY, token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 consumed_at timestamptz, flow_hash text, created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON owner_initialization,owner_setup_credentials FROM PUBLIC;
CREATE FUNCTION owner_setup_available() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NOT closed AND NOT EXISTS(SELECT 1 FROM public.users WHERE role='Owner' AND deleted_at IS NULL)
 AND EXISTS(SELECT 1 FROM public.owner_setup_credentials WHERE consumed_at IS NULL AND expires_at>now() AND attempts<5)
 FROM public.owner_initialization WHERE singleton
$$;
CREATE FUNCTION begin_owner_setup(credential_id uuid, supplied_hash text, state_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE credential public.owner_setup_credentials%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(77702);
 IF (SELECT closed FROM public.owner_initialization WHERE singleton) OR EXISTS(SELECT 1 FROM public.users WHERE role='Owner' AND deleted_at IS NULL) THEN RETURN false; END IF;
 SELECT * INTO credential FROM public.owner_setup_credentials WHERE id=credential_id FOR UPDATE;
 IF NOT FOUND OR credential.consumed_at IS NOT NULL OR credential.expires_at<=now() OR credential.attempts>=5 THEN RETURN false; END IF;
 UPDATE public.owner_setup_credentials SET attempts=attempts+1 WHERE id=credential_id;
 IF credential.token_hash<>supplied_hash THEN RETURN false; END IF;
 UPDATE public.owner_setup_credentials SET consumed_at=now(),flow_hash=state_hash WHERE id=credential_id;
 RETURN true;
END $$;
CREATE FUNCTION complete_owner_setup(credential_id uuid,state_hash text,verified_sub text,verified_email text,verified_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner_uuid uuid; credential public.owner_setup_credentials%ROWTYPE; existing_user public.users%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(77702);
 PERFORM 1 FROM public.owner_initialization WHERE singleton FOR UPDATE;
 IF (SELECT closed FROM public.owner_initialization WHERE singleton) OR EXISTS(SELECT 1 FROM public.users WHERE role='Owner' AND deleted_at IS NULL) THEN RAISE EXCEPTION 'owner initialization closed'; END IF;
 SELECT * INTO credential FROM public.owner_setup_credentials WHERE id=credential_id FOR UPDATE;
 IF NOT FOUND OR credential.consumed_at IS NULL OR credential.expires_at<=now() OR credential.flow_hash IS DISTINCT FROM state_hash THEN RAISE EXCEPTION 'owner authorization invalid'; END IF;
 IF length(verified_sub)<1 OR length(verified_email)<1 THEN RAISE EXCEPTION 'identity missing'; END IF;
 SELECT u.* INTO existing_user FROM public.users u JOIN public.google_identities g ON g.user_id=u.id WHERE g.sub=verified_sub FOR UPDATE OF u;
 IF FOUND THEN
  IF existing_user.disabled OR existing_user.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'identity disabled'; END IF;
  owner_uuid=existing_user.id;
  UPDATE public.users SET role='Owner',updated_at=now() WHERE id=owner_uuid;
 ELSE
  IF (SELECT count(*) FROM public.users WHERE deleted_at IS NULL) >= coalesce((SELECT (value::text)::integer FROM public.settings WHERE key='seat_limit'),20) THEN RAISE EXCEPTION 'seat limit reached'; END IF;
  INSERT INTO public.users(email,name,role) VALUES(verified_email,verified_name,'Owner') RETURNING id INTO owner_uuid;
  INSERT INTO public.google_identities(user_id,sub) VALUES(owner_uuid,verified_sub);
 END IF;
 UPDATE public.owner_initialization SET owner_id=owner_uuid,google_sub=verified_sub,completed_at=now(),closed=true WHERE singleton;
 UPDATE public.owner_setup_credentials SET expires_at=now();
 UPDATE public.sessions SET revoked_at=now() WHERE owner_id=owner_uuid AND revoked_at IS NULL;
 INSERT INTO public.audit_events(owner_id,action) VALUES(owner_uuid,'owner.initialized');
 RETURN owner_uuid;
END $$;
REVOKE ALL ON FUNCTION begin_owner_setup(uuid,text,text),complete_owner_setup(uuid,text,text,text,text),owner_setup_available() FROM PUBLIC;
CREATE FUNCTION protect_bound_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.owner_initialization WHERE closed AND owner_id=OLD.id) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'bound owner protected'; END IF;
  IF NEW.role<>OLD.role OR NEW.disabled OR NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'bound owner protected'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bound_owner_protected BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION protect_bound_owner();

CREATE FUNCTION restrict_owner_role() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.role='Owner' AND (TG_OP='INSERT' OR OLD.role<>'Owner') AND current_user<>(SELECT pg_get_userbyid(proowner) FROM pg_catalog.pg_proc WHERE oid='public.complete_owner_setup(uuid,text,text,text,text)'::regprocedure) THEN RAISE EXCEPTION 'Owner requires local authorization'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_role_restricted BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION restrict_owner_role();

CREATE FUNCTION owner_identity_allowed(verified_sub text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NOT closed OR google_sub=verified_sub FROM public.owner_initialization WHERE singleton
$$;
REVOKE ALL ON FUNCTION owner_identity_allowed(text) FROM PUBLIC;

CREATE FUNCTION protect_owner_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.owner_initialization WHERE closed AND google_sub=OLD.sub) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'bound Google identity protected'; END IF;
  IF NEW.sub<>OLD.sub OR NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'bound Google identity protected'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bound_google_identity_protected BEFORE UPDATE OR DELETE ON google_identities FOR EACH ROW EXECUTE FUNCTION protect_owner_identity();
