use std::collections::HashSet;
use std::error::Error;
use std::fmt;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::protocol::{
    BrowserOperation, ModelDecisionEnvelopeV1, ModelDecisionV1, ModelWireBrowserOperationV1,
    ModelWireDecisionV1,
};

const MODEL_DECISION_SCHEMA: &str =
    include_str!("../../../host/browser-runtime/protocol/model-decision-envelope-v1.schema.json");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecisionProtocolError {
    pub category: &'static str,
}

impl DecisionProtocolError {
    fn protocol() -> Self {
        Self {
            category: "model_protocol_error",
        }
    }

    fn schema() -> Self {
        Self {
            category: "model_schema_invalid",
        }
    }
}

impl fmt::Display for DecisionProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.category)
    }
}

impl Error for DecisionProtocolError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    ReadOnly,
    SideEffecting,
}

pub fn load_model_decision_envelope_schema() -> Result<Value, DecisionProtocolError> {
    let schema: Value =
        serde_json::from_str(MODEL_DECISION_SCHEMA).map_err(|_| DecisionProtocolError::schema())?;
    validate_model_wire_schema_definition(&schema)?;
    validate_schema_root(&schema)?;
    Ok(schema)
}

pub fn validate_model_wire_schema_definition(schema: &Value) -> Result<(), DecisionProtocolError> {
    fn visit(node: &Value) -> Result<(), DecisionProtocolError> {
        match node {
            Value::Array(items) => {
                for item in items {
                    visit(item)?;
                }
            }
            Value::Object(object) => {
                if object.contains_key("const") {
                    return Err(DecisionProtocolError::schema());
                }
                let scalar_keywords = [
                    "enum",
                    "minimum",
                    "maximum",
                    "minLength",
                    "maxLength",
                    "minItems",
                    "maxItems",
                ];
                if scalar_keywords.iter().any(|key| object.contains_key(*key))
                    && !object.contains_key("type")
                {
                    return Err(DecisionProtocolError::schema());
                }
                if !object.contains_key("type")
                    && !["anyOf", "oneOf", "allOf"]
                        .iter()
                        .any(|key| object.contains_key(*key))
                {
                    return Err(DecisionProtocolError::schema());
                }
                if let Some(kind) = object.get("type") {
                    let Some(kind) = kind.as_str() else {
                        return Err(DecisionProtocolError::schema());
                    };
                    if ![
                        "null", "boolean", "object", "array", "number", "string", "integer",
                    ]
                    .contains(&kind)
                    {
                        return Err(DecisionProtocolError::schema());
                    }
                }
                if object.get("type") == Some(&Value::String("object".to_owned())) {
                    let properties = object
                        .get("properties")
                        .and_then(Value::as_object)
                        .ok_or_else(DecisionProtocolError::schema)?;
                    let required = object
                        .get("required")
                        .and_then(Value::as_array)
                        .ok_or_else(DecisionProtocolError::schema)?;
                    if object.get("additionalProperties") != Some(&Value::Bool(false))
                        || required.len() != properties.len()
                        || properties.keys().any(|name| {
                            required
                                .iter()
                                .filter(|required| required.as_str() == Some(name))
                                .count()
                                != 1
                        })
                    {
                        return Err(DecisionProtocolError::schema());
                    }
                }
                if let Some(values) = object.get("enum") {
                    let Some(values) = values.as_array() else {
                        return Err(DecisionProtocolError::schema());
                    };
                    if values.is_empty() {
                        return Err(DecisionProtocolError::schema());
                    }
                    let kind = object
                        .get("type")
                        .and_then(Value::as_str)
                        .ok_or_else(DecisionProtocolError::schema)?;
                    if !values.iter().all(|value| instance_has_type(value, kind)) {
                        return Err(DecisionProtocolError::schema());
                    }
                }
                if let Some(properties) = object.get("properties") {
                    let properties = properties
                        .as_object()
                        .ok_or_else(DecisionProtocolError::schema)?;
                    for child in properties.values() {
                        visit(child)?;
                    }
                }
                if let Some(items) = object.get("items") {
                    visit(items)?;
                }
                for union in ["anyOf", "oneOf", "allOf"] {
                    if let Some(branches) = object.get(union) {
                        let branches = branches
                            .as_array()
                            .ok_or_else(DecisionProtocolError::schema)?;
                        for branch in branches {
                            visit(branch)?;
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(schema)
}

fn validate_schema_root(schema: &Value) -> Result<(), DecisionProtocolError> {
    let root = schema
        .as_object()
        .ok_or_else(DecisionProtocolError::schema)?;
    let exact_root_keys = ["additionalProperties", "properties", "required", "type"];
    if root.len() != exact_root_keys.len()
        || !exact_root_keys.iter().all(|key| root.contains_key(*key))
        || root.get("type") != Some(&Value::String("object".to_owned()))
        || root.get("additionalProperties") != Some(&Value::Bool(false))
    {
        return Err(DecisionProtocolError::schema());
    }
    let properties = root
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(DecisionProtocolError::schema)?;
    let required = root
        .get("required")
        .and_then(Value::as_array)
        .ok_or_else(DecisionProtocolError::schema)?;
    if properties.len() != 1
        || !properties.contains_key("decision")
        || required != &[Value::String("decision".to_owned())]
        || properties
            .get("decision")
            .and_then(Value::as_object)
            .is_none_or(|decision| {
                decision.len() != 1
                    || decision
                        .get("anyOf")
                        .and_then(Value::as_array)
                        .is_none_or(|branches| branches.len() != 2)
            })
    {
        return Err(DecisionProtocolError::schema());
    }
    Ok(())
}

pub fn parse_decision_envelope(
    input: &str,
) -> Result<ModelDecisionEnvelopeV1, DecisionProtocolError> {
    let instance: Value =
        serde_json::from_str(input).map_err(|_| DecisionProtocolError::protocol())?;
    let schema =
        load_model_decision_envelope_schema().map_err(|_| DecisionProtocolError::protocol())?;
    validate_instance(&schema, &instance).map_err(|_| DecisionProtocolError::protocol())?;
    serde_json::from_str(input).map_err(|_| DecisionProtocolError::protocol())
}

pub fn normalize_model_decision_envelope(envelope: ModelDecisionEnvelopeV1) -> ModelDecisionV1 {
    match envelope.decision {
        ModelWireDecisionV1::Final { version, output } => {
            ModelDecisionV1::Final { version, output }
        }
        ModelWireDecisionV1::Action { version, action } => {
            let action = match action {
                ModelWireBrowserOperationV1::Snapshot => BrowserOperation::Snapshot,
                ModelWireBrowserOperationV1::Click { r#ref } => BrowserOperation::Click { r#ref },
                ModelWireBrowserOperationV1::Fill { r#ref, value } => {
                    BrowserOperation::Fill { r#ref, value }
                }
                ModelWireBrowserOperationV1::Type {
                    r#ref,
                    value,
                    delay_ms,
                } => BrowserOperation::Type {
                    r#ref,
                    value,
                    delay_ms,
                },
                ModelWireBrowserOperationV1::Press { r#ref, key } => {
                    BrowserOperation::Press { r#ref, key }
                }
                ModelWireBrowserOperationV1::Select { r#ref, values } => {
                    BrowserOperation::Select { r#ref, values }
                }
                ModelWireBrowserOperationV1::Scroll { delta_x, delta_y } => {
                    BrowserOperation::Scroll { delta_x, delta_y }
                }
                ModelWireBrowserOperationV1::Wait { milliseconds } => {
                    BrowserOperation::Wait { milliseconds }
                }
                ModelWireBrowserOperationV1::GetText { r#ref } => {
                    BrowserOperation::GetText { r#ref: r#ref.0 }
                }
                ModelWireBrowserOperationV1::GetUrl => BrowserOperation::GetUrl,
                ModelWireBrowserOperationV1::Navigate { url } => BrowserOperation::Navigate { url },
                ModelWireBrowserOperationV1::Evaluate {
                    expression,
                    args: _,
                } => BrowserOperation::Evaluate {
                    expression,
                    args: Default::default(),
                },
            };
            ModelDecisionV1::Action { version, action }
        }
    }
}

pub fn normalized_hash(decision: &ModelDecisionV1) -> String {
    let value = match decision {
        ModelDecisionV1::Action { action, .. } => {
            serde_json::to_value(action).expect("browser operations always serialize")
        }
        ModelDecisionV1::Final { .. } => {
            serde_json::to_value(decision).expect("model decisions always serialize")
        }
    };
    let canonical = serde_json::to_vec(&value).expect("JSON values always serialize");
    format!("{:x}", Sha256::digest(canonical))
}

pub fn classify(decision: &ModelDecisionV1) -> Effect {
    match decision {
        ModelDecisionV1::Final { .. }
        | ModelDecisionV1::Action {
            action:
                BrowserOperation::Snapshot
                | BrowserOperation::Wait { .. }
                | BrowserOperation::GetText { .. }
                | BrowserOperation::GetUrl,
            ..
        } => Effect::ReadOnly,
        ModelDecisionV1::Action { .. } => Effect::SideEffecting,
    }
}

#[derive(Debug, Default)]
pub struct DecisionDuplicateGuard {
    side_effect_hashes: HashSet<String>,
}

impl DecisionDuplicateGuard {
    pub fn check_and_record(
        &mut self,
        decision: &ModelDecisionV1,
    ) -> Result<(), DecisionProtocolError> {
        if classify(decision) == Effect::ReadOnly {
            return Ok(());
        }
        if self.side_effect_hashes.insert(normalized_hash(decision)) {
            Ok(())
        } else {
            Err(DecisionProtocolError::protocol())
        }
    }
}

fn validate_instance(schema: &Value, instance: &Value) -> Result<(), ()> {
    let schema = schema.as_object().ok_or(())?;
    if let Some(any_of) = schema.get("anyOf") {
        let branches = any_of.as_array().ok_or(())?;
        if branches
            .iter()
            .filter(|branch| validate_instance(branch, instance).is_ok())
            .count()
            != 1
        {
            return Err(());
        }
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str)
        && !instance_has_type(instance, kind)
    {
        return Err(());
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array)
        && !values.contains(instance)
    {
        return Err(());
    }
    match instance {
        Value::Object(object) => validate_object(schema, object)?,
        Value::Array(items) => {
            if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64)
                && items.len() as u64 > maximum
            {
                return Err(());
            }
            if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64)
                && (items.len() as u64) < minimum
            {
                return Err(());
            }
            if let Some(item_schema) = schema.get("items") {
                for item in items {
                    validate_instance(item_schema, item)?;
                }
            }
        }
        Value::String(value) => {
            let length = value.chars().count() as u64;
            if schema
                .get("maxLength")
                .and_then(Value::as_u64)
                .is_some_and(|maximum| length > maximum)
                || schema
                    .get("minLength")
                    .and_then(Value::as_u64)
                    .is_some_and(|minimum| length < minimum)
            {
                return Err(());
            }
        }
        Value::Number(value) => {
            let value = value.as_f64().ok_or(())?;
            if schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|maximum| value > maximum)
                || schema
                    .get("minimum")
                    .and_then(Value::as_f64)
                    .is_some_and(|minimum| value < minimum)
            {
                return Err(());
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_object(schema: &Map<String, Value>, object: &Map<String, Value>) -> Result<(), ()> {
    let Some(properties) = schema.get("properties") else {
        return Ok(());
    };
    let properties = properties.as_object().ok_or(())?;
    let required = schema.get("required").and_then(Value::as_array).ok_or(())?;
    for name in required {
        if !object.contains_key(name.as_str().ok_or(())?) {
            return Err(());
        }
    }
    if schema.get("additionalProperties") == Some(&Value::Bool(false))
        && object.keys().any(|name| !properties.contains_key(name))
    {
        return Err(());
    }
    for (name, value) in object {
        if let Some(property_schema) = properties.get(name) {
            validate_instance(property_schema, value)?;
        }
    }
    Ok(())
}

fn instance_has_type(instance: &Value, kind: &str) -> bool {
    match kind {
        "null" => instance.is_null(),
        "boolean" => instance.is_boolean(),
        "object" => instance.is_object(),
        "array" => instance.is_array(),
        "number" => instance.is_number(),
        "integer" => instance.as_i64().is_some() || instance.as_u64().is_some(),
        "string" => instance.is_string(),
        _ => false,
    }
}
