CREATE FUNCTION retention_propagate_resolved_request_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kind = 'async_placeholder'
     AND NEW.kind <> 'async_placeholder' THEN
    UPDATE webhook_logs
       SET dr_clean_by = NEW.dr_clean_by
     WHERE request_id = NEW.id
       AND dr_clean_by IS DISTINCT FROM NEW.dr_clean_by;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER retention_propagate_resolved_request_deadline
AFTER UPDATE OF kind ON requests
FOR EACH ROW
EXECUTE FUNCTION retention_propagate_resolved_request_deadline();
