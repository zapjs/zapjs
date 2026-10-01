use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Segment {
    Static(String),
    Param(String),
    CatchAll(String),
    OptionalCatchAll(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    pub pattern: String,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RouteError {
    #[error("route must begin with /: {0}")]
    Absolute(String),
    #[error("invalid route segment: {0}")]
    Segment(String),
    #[error("catch-all must be the last segment: {0}")]
    CatchAll(String),
    #[error("duplicate parameter name: {0}")]
    DuplicateParam(String),
    #[error("ambiguous route patterns: {0} and {1}")]
    Ambiguous(String, String),
    #[error("duplicate route identifier: {0}")]
    DuplicateId(String),
    #[error("malformed or unsafe URL path")]
    Path,
}

impl Route {
    pub fn parse(id: impl Into<String>, pattern: &str) -> Result<Self, RouteError> {
        if !pattern.starts_with('/') {
            return Err(RouteError::Absolute(pattern.into()));
        }
        let mut segments = Vec::new();
        let mut names = HashSet::new();
        let parts: Vec<_> = pattern
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        for (index, part) in parts.iter().enumerate() {
            let segment = if let Some(name) = part
                .strip_prefix("[[...")
                .and_then(|s| s.strip_suffix("]]"))
            {
                Segment::OptionalCatchAll(name.into())
            } else if let Some(name) = part.strip_prefix("[...").and_then(|s| s.strip_suffix(']')) {
                Segment::CatchAll(name.into())
            } else if let Some(name) = part.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                Segment::Param(name.into())
            } else {
                if part.contains(['[', ']', '?', '#', '\\', '%']) {
                    return Err(RouteError::Segment((*part).into()));
                }
                Segment::Static((*part).into())
            };
            if let Segment::Param(name)
            | Segment::CatchAll(name)
            | Segment::OptionalCatchAll(name) = &segment
            {
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Err(RouteError::Segment((*part).into()));
                }
                if !names.insert(name.clone()) {
                    return Err(RouteError::DuplicateParam(name.clone()));
                }
            }
            if matches!(segment, Segment::CatchAll(_) | Segment::OptionalCatchAll(_))
                && index + 1 != parts.len()
            {
                return Err(RouteError::CatchAll(pattern.into()));
            }
            segments.push(segment);
        }
        Ok(Self {
            id: id.into(),
            pattern: pattern.into(),
            segments,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Param {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug)]
pub struct Matched<'a> {
    pub route: &'a Route,
    pub params: BTreeMap<String, Param>,
}

#[derive(Debug, Default)]
struct TrieNode {
    literals: BTreeMap<String, TrieNode>,
    param: Option<Box<TrieNode>>,
    endpoint: Option<usize>,
    catch_all: Option<usize>,
    optional: Option<usize>,
}

/// Compiled immutable routing trie; request lookup never scans unrelated routes.
#[derive(Debug)]
pub struct Router {
    routes: Vec<Route>,
    root: TrieNode,
}

impl Router {
    pub fn new(routes: Vec<Route>) -> Result<Self, RouteError> {
        let mut root = TrieNode::default();
        let mut ids = HashSet::new();
        for (index, route) in routes.iter().enumerate() {
            if !ids.insert(&route.id) {
                return Err(RouteError::DuplicateId(route.id.clone()));
            }
            let mut cursor = &mut root;
            let mut terminal = None;
            for segment in &route.segments {
                match segment {
                    Segment::Static(value) => {
                        cursor = cursor.literals.entry(value.clone()).or_default()
                    }
                    Segment::Param(_) => cursor = cursor.param.get_or_insert_with(Default::default),
                    Segment::CatchAll(_) => {
                        terminal = Some(&mut cursor.catch_all);
                        break;
                    }
                    Segment::OptionalCatchAll(_) => {
                        terminal = Some(&mut cursor.optional);
                        break;
                    }
                }
            }
            let slot = terminal.unwrap_or(&mut cursor.endpoint);
            if let Some(previous) = slot.replace(index) {
                return Err(RouteError::Ambiguous(
                    routes[previous].pattern.clone(),
                    route.pattern.clone(),
                ));
            }
        }
        Ok(Self { routes, root })
    }

    pub fn routes(&self) -> &[Route] {
        &self.routes
    }

    pub fn resolve(&self, path: &str) -> Result<Option<Matched<'_>>, RouteError> {
        let parts = decode_path(path)?;
        let Some(index) = find(&self.root, &parts, 0) else {
            return Ok(None);
        };
        let route = &self.routes[index];
        let mut params = BTreeMap::new();
        for (offset, segment) in route.segments.iter().enumerate() {
            match segment {
                Segment::Param(name) => {
                    params.insert(name.clone(), Param::One(parts[offset].clone()));
                }
                Segment::CatchAll(name) | Segment::OptionalCatchAll(name) => {
                    params.insert(name.clone(), Param::Many(parts[offset..].to_vec()));
                }
                Segment::Static(_) => {}
            }
        }
        Ok(Some(Matched { route, params }))
    }
}

fn find(cursor: &TrieNode, parts: &[String], offset: usize) -> Option<usize> {
    if offset == parts.len() {
        return cursor.endpoint.or(cursor.optional);
    }
    if let Some(branch) = cursor.literals.get(&parts[offset]) {
        if let Some(index) = find(branch, parts, offset + 1) {
            return Some(index);
        }
    }
    if let Some(branch) = &cursor.param {
        if let Some(index) = find(branch, parts, offset + 1) {
            return Some(index);
        }
    }
    cursor.catch_all.or(cursor.optional)
}

fn decode_path(path: &str) -> Result<Vec<String>, RouteError> {
    if !path.starts_with('/') || path.len() > 16 * 1024 || path.contains(['?', '#', '\\']) {
        return Err(RouteError::Path);
    }
    let mut result = Vec::new();
    for part in path.trim_matches('/').split('/').filter(|s| !s.is_empty()) {
        let bytes = part.as_bytes();
        for (i, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit())
            {
                return Err(RouteError::Path);
            }
        }
        let value = percent_decode_str(part)
            .decode_utf8()
            .map_err(|_| RouteError::Path)?
            .into_owned();
        if value == "."
            || value == ".."
            || value
                .chars()
                .any(|c| c == '/' || c == '\\' || c.is_control())
        {
            return Err(RouteError::Path);
        }
        result.push(value);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn router(paths: &[&str]) -> Router {
        Router::new(paths.iter().map(|p| Route::parse(*p, p).unwrap()).collect()).unwrap()
    }
    #[test]
    fn precedence_and_branch_backtracking() {
        let r = router(&[
            "/shop/[...all]",
            "/shop/[id]/edit",
            "/shop/fixed/view",
            "/shop/[[...optional]]",
            "/shop",
        ]);
        for (url, id) in [
            ("/shop", "/shop"),
            ("/shop/fixed/view", "/shop/fixed/view"),
            ("/shop/fixed/edit", "/shop/[id]/edit"),
            ("/shop/a/b", "/shop/[...all]"),
        ] {
            assert_eq!(r.resolve(url).unwrap().unwrap().route.id, id);
        }
        assert!(r.resolve("/missing").unwrap().is_none());
    }
    #[test]
    fn parameters_and_utf8() {
        let r = router(&["/items/[id]", "/files/[[...path]]"]);
        assert_eq!(
            r.resolve("/items/caf%C3%A9").unwrap().unwrap().params["id"],
            Param::One("café".into())
        );
        assert_eq!(
            r.resolve("/files").unwrap().unwrap().params["path"],
            Param::Many(vec![])
        );
        assert_eq!(
            r.resolve("/files/a/b").unwrap().unwrap().params["path"],
            Param::Many(vec!["a".into(), "b".into()])
        );
    }
    #[test]
    fn rejects_unsafe_paths_and_ambiguous_patterns() {
        let r = router(&["/items/[id]"]);
        for path in [
            "/items/%",
            "/items/%0G",
            "/items/%ff",
            "/items/a%2fb",
            "/items/%5C",
            "/items/%00",
            "/items/%2e%2e",
            "/items/a?b",
        ] {
            assert_eq!(r.resolve(path).unwrap_err(), RouteError::Path);
        }
        for path in ["/[id]/[id]", "/[...all]/child", "/[]", "/[bad-name]"] {
            assert!(Route::parse("x", path).is_err());
        }
        assert!(
            Router::new(vec![
                Route::parse("a", "/[id]").unwrap(),
                Route::parse("b", "/[slug]").unwrap()
            ])
            .is_err()
        );
    }
}
