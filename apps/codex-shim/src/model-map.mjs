const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

function readModel(value, fallback, name) {
  const model = value || fallback;
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    throw new TypeError(`${name} must be a valid model name`);
  }
  return model;
}

export function readModelConfig(env = process.env) {
  return Object.freeze({
    small: readModel(
      env.CODEX_SHIM_SMALL_MODEL,
      "gpt-5.6-luna",
      "CODEX_SHIM_SMALL_MODEL",
    ),
    main: readModel(
      env.CODEX_SHIM_MAIN_MODEL,
      "gpt-5.6-terra",
      "CODEX_SHIM_MAIN_MODEL",
    ),
  });
}

// @lat: [[codex-shim#Model tiers and readiness]]
export function mapModel(requestedModel, models = readModelConfig()) {
  const small = /mini|nano/iu.test(requestedModel);
  return Object.freeze({
    model: small ? models.small : models.main,
    effort: small ? "low" : "medium",
  });
}
