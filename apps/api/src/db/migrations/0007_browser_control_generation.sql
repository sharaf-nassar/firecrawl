CREATE TABLE browser_control_generation (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  database_control_epoch bigint NOT NULL,
  api_instance_id uuid NOT NULL,
  process_nonce text NOT NULL,
  control_generation_nonce text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_control_generation_singleton_check
    CHECK (singleton_id = 1),
  CONSTRAINT browser_control_generation_epoch_check
    CHECK (database_control_epoch > 0),
  CONSTRAINT browser_control_generation_api_instance_check
    CHECK (api_instance_id::text = lower(api_instance_id::text)),
  CONSTRAINT browser_control_generation_process_nonce_check
    CHECK (
      process_nonce ~ '^[A-Za-z0-9_-]{43}$'
      AND length(decode(
        translate(process_nonce || repeat(
          '=',
          (4 - length(process_nonce) % 4) % 4
        ), '-_', '+/'),
        'base64'
      )) = 32
      AND rtrim(translate(encode(decode(
        translate(process_nonce || repeat(
          '=',
          (4 - length(process_nonce) % 4) % 4
        ), '-_', '+/'),
        'base64'
      ), 'base64'), '+/', '-_'), '=') = process_nonce
    ),
  CONSTRAINT browser_control_generation_control_nonce_check
    CHECK (
      control_generation_nonce ~ '^[A-Za-z0-9_-]{43}$'
      AND length(decode(
        translate(control_generation_nonce || repeat(
          '=',
          (4 - length(control_generation_nonce) % 4) % 4
        ), '-_', '+/'),
        'base64'
      )) = 32
      AND rtrim(translate(encode(decode(
        translate(control_generation_nonce || repeat(
          '=',
          (4 - length(control_generation_nonce) % 4) % 4
        ), '-_', '+/'),
        'base64'
      ), 'base64'), '+/', '-_'), '=') = control_generation_nonce
    )
);

REVOKE INSERT, DELETE, TRUNCATE ON browser_control_generation FROM PUBLIC;
