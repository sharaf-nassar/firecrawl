use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};

pub const MAX_FINAL_OUTPUT_BYTES: usize = 262_144;

struct NoDuplicateJson(Value);

impl<'de> Deserialize<'de> for NoDuplicateJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(NoDuplicateJsonVisitor)
    }
}

struct NoDuplicateJsonVisitor;

impl<'de> Visitor<'de> for NoDuplicateJsonVisitor {
    type Value = NoDuplicateJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::Number(Number::from(value))))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::Number(Number::from(value))))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .map(NoDuplicateJson)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicateJson(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<NoDuplicateJson>()? {
            values.push(value.0);
        }
        Ok(NoDuplicateJson(Value::Array(values)))
    }

    fn visit_map<A>(self, mut entries: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = entries.next_key::<String>()? {
            let value = entries.next_value::<NoDuplicateJson>()?.0;
            if values.insert(key, value).is_some() {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
        }
        Ok(NoDuplicateJson(Value::Object(values)))
    }
}

pub fn parse_json_strict<T>(raw: &[u8]) -> Result<T, serde_json::Error>
where
    T: DeserializeOwned,
{
    let mut deserializer = serde_json::Deserializer::from_slice(raw);
    let value = NoDuplicateJson::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    T::deserialize(value)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VersionOne;

impl Serialize for VersionOne {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(1)
    }
}

impl<'de> Deserialize<'de> for VersionOne {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u64::deserialize(deserializer)?;
        if version == 1 {
            Ok(Self)
        } else {
            Err(de::Error::custom("version must be 1"))
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct BoundedString<const MAX: usize>(String);

impl<const MAX: usize> BoundedString<MAX> {
    pub fn new(value: String) -> Result<Self, String> {
        if value.chars().count() > MAX {
            return Err(format!("string exceeds {MAX} characters"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

impl<const MAX: usize> fmt::Display for BoundedString<MAX> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<const MAX: usize> AsRef<str> for BoundedString<MAX> {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl<const MAX: usize> Serialize for BoundedString<MAX> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for BoundedString<MAX> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedVec<T, const MAX: usize>(Vec<T>);

impl<T, const MAX: usize> BoundedVec<T, MAX> {
    pub fn new(value: Vec<T>) -> Result<Self, String> {
        if value.len() > MAX {
            return Err(format!("array exceeds {MAX} items"));
        }
        Ok(Self(value))
    }

    pub fn as_slice(&self) -> &[T] {
        &self.0
    }

    pub fn into_inner(self) -> Vec<T> {
        self.0
    }
}

impl<T, const MAX: usize> Serialize for BoundedVec<T, MAX>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de, T, const MAX: usize> Deserialize<'de> for BoundedVec<T, MAX>
where
    T: DeserializeOwned,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Vec::<T>::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ElementRef(BoundedString<128>);

impl ElementRef {
    pub fn new(value: String) -> Result<Self, String> {
        let value = BoundedString::new(value)?;
        if value.as_str().is_empty() {
            return Err("element reference cannot be empty".to_owned());
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl Serialize for ElementRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ElementRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelDecisionV1 {
    Action {
        version: VersionOne,
        action: BrowserOperation,
    },
    Final {
        version: VersionOne,
        #[serde(deserialize_with = "deserialize_final_output")]
        output: String,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelDecisionEnvelopeV1 {
    pub decision: ModelWireDecisionV1,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelWireDecisionV1 {
    Action {
        version: VersionOne,
        action: ModelWireBrowserOperationV1,
    },
    Final {
        version: VersionOne,
        #[serde(deserialize_with = "deserialize_final_output")]
        output: String,
    },
}

fn deserialize_final_output<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let output = String::deserialize(deserializer)?;
    if output.len() > MAX_FINAL_OUTPUT_BYTES {
        return Err(de::Error::custom("final output exceeds 262144 bytes"));
    }
    Ok(output)
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct RequiredNullable<T>(pub Option<T>);

#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelWireBrowserOperationV1 {
    Snapshot,
    Click {
        r#ref: ElementRef,
    },
    Fill {
        r#ref: ElementRef,
        value: BoundedString<20_000>,
    },
    Type {
        r#ref: ElementRef,
        value: BoundedString<20_000>,
        #[serde(rename = "delayMs", deserialize_with = "deserialize_delay_ms")]
        delay_ms: u16,
    },
    Press {
        r#ref: ElementRef,
        key: BoundedString<64>,
    },
    Select {
        r#ref: ElementRef,
        values: BoundedVec<BoundedString<512>, 20>,
    },
    Scroll {
        #[serde(rename = "deltaX", deserialize_with = "deserialize_scroll_delta")]
        delta_x: i32,
        #[serde(rename = "deltaY", deserialize_with = "deserialize_scroll_delta")]
        delta_y: i32,
    },
    Wait {
        #[serde(deserialize_with = "deserialize_wait_ms")]
        milliseconds: u32,
    },
    GetText {
        r#ref: RequiredNullable<ElementRef>,
    },
    GetUrl,
    Navigate {
        url: BoundedString<8_192>,
    },
    Evaluate {
        expression: BoundedString<20_000>,
        args: EmptyArgs,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserOperation {
    Snapshot,
    Click {
        r#ref: ElementRef,
    },
    Fill {
        r#ref: ElementRef,
        value: BoundedString<20_000>,
    },
    Type {
        r#ref: ElementRef,
        value: BoundedString<20_000>,
        #[serde(rename = "delayMs", deserialize_with = "deserialize_delay_ms")]
        delay_ms: u16,
    },
    Press {
        r#ref: ElementRef,
        key: BoundedString<64>,
    },
    Select {
        r#ref: ElementRef,
        values: BoundedVec<BoundedString<512>, 20>,
    },
    Scroll {
        #[serde(rename = "deltaX", deserialize_with = "deserialize_scroll_delta")]
        delta_x: i32,
        #[serde(rename = "deltaY", deserialize_with = "deserialize_scroll_delta")]
        delta_y: i32,
    },
    Wait {
        #[serde(deserialize_with = "deserialize_wait_ms")]
        milliseconds: u32,
    },
    GetText {
        #[serde(skip_serializing_if = "Option::is_none")]
        r#ref: Option<ElementRef>,
    },
    GetUrl,
    Navigate {
        url: BoundedString<8_192>,
    },
    Evaluate {
        expression: BoundedString<20_000>,
        args: BTreeMap<String, serde_json::Value>,
    },
}

fn deserialize_delay_ms<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value > 250 {
        return Err(de::Error::custom("delayMs exceeds 250"));
    }
    Ok(value)
}

fn deserialize_scroll_delta<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = i32::deserialize(deserializer)?;
    if !(-10_000..=10_000).contains(&value) {
        return Err(de::Error::custom("scroll delta is out of range"));
    }
    Ok(value)
}

fn deserialize_wait_ms<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value > 30_000 {
        return Err(de::Error::custom("wait exceeds 30000 milliseconds"));
    }
    Ok(value)
}
