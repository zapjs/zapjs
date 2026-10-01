use crate::routing::{Param, Route as RuntimeRoute, RouteError, Router};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModuleKind {
    Server,
    Client,
    ServerActions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RouteKind {
    Page,
    Handler,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DynamicPolicy {
    Auto,
    ForceStatic,
    ForceDynamic,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachePolicy {
    pub dynamic: DynamicPolicy,
    pub revalidate_seconds: Option<u64>,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            dynamic: DynamicPolicy::Auto,
            revalidate_seconds: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleRef {
    pub id: String,
    pub path: PathBuf,
    pub kind: ModuleKind,
    pub browser_chunk: Option<PathBuf>,
    pub server_bundle: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionRef {
    pub id: String,
    pub module: String,
    pub export: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientReference {
    pub id: String,
    pub module: String,
    pub export: String,
    pub path: PathBuf,
    pub browser_chunk: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientHydrationReference {
    pub id: String,
    pub module: String,
    pub export: String,
    pub browser_chunk: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteHydration {
    pub client_references: Vec<ClientHydrationReference>,
    pub browser_chunks: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutRef {
    pub id: String,
    pub path: PathBuf,
    pub depth: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteEntry {
    pub id: String,
    pub pattern: String,
    pub kind: RouteKind,
    pub source: PathBuf,
    pub layouts: Vec<String>,
    pub module: String,
    pub methods: Vec<String>,
    pub cache: CachePolicy,
    pub client_references: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetRef {
    pub source: PathBuf,
    pub url_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationManifest {
    pub routes: Vec<RouteEntry>,
    pub layouts: Vec<LayoutRef>,
    pub modules: Vec<ModuleRef>,
    pub actions: Vec<ActionRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_proxy: Option<PathBuf>,
    pub client_references: Vec<ClientReference>,
    pub assets: Vec<AssetRef>,
}

impl ApplicationManifest {
    pub fn to_manifest_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub fn from_manifest_json(input: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(input)
    }
}

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("read application manifest {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("parse application manifest {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("invalid application manifest route: {0}")]
    Route(#[from] RouteError),
    #[error("route {route} references missing module {module}")]
    MissingRouteModule { route: String, module: String },
    #[error("route {route} references non-server module {module}")]
    InvalidRouteModuleKind { route: String, module: String },
    #[error("route {route} references missing layout {layout}")]
    MissingLayout { route: String, layout: String },
    #[error("route {route} references missing client reference {reference}")]
    MissingRouteClientReference { route: String, reference: String },
    #[error("route {route} has duplicate client reference {reference}")]
    DuplicateRouteClientReference { route: String, reference: String },
    #[error("action {action} references missing module {module}")]
    MissingActionModule { action: String, module: String },
    #[error("action {action} references non-action module {module}")]
    InvalidActionModuleKind { action: String, module: String },
    #[error("module {module} is missing a server bundle")]
    MissingServerBundle { module: String },
    #[error("module {module} has an empty server bundle path")]
    EmptyServerBundle { module: String },
    #[error("module {module} has an unsafe source path: {path}")]
    InvalidModulePath { module: String, path: PathBuf },
    #[error("module {module} has an unsafe bundle path: {path}")]
    InvalidBundlePath { module: String, path: PathBuf },
    #[error("client module {module} must not declare a server bundle")]
    UnexpectedClientServerBundle { module: String },
    #[error("client module {module} is missing a browser chunk")]
    MissingBrowserChunk { module: String },
    #[error("layout {layout} has an unsafe source path: {path}")]
    InvalidLayoutPath { layout: String, path: PathBuf },
    #[error("action {action} has an unsafe source path: {path}")]
    InvalidActionPath { action: String, path: PathBuf },
    #[error("action {action} has an invalid export name: {export}")]
    InvalidActionExport { action: String, export: String },
    #[error("action {action} id does not match module/export identity")]
    InvalidActionId { action: String },
    #[error("action proxy has an unsafe bundle path: {path}")]
    InvalidActionProxyPath { path: PathBuf },
    #[error("client reference {reference} references missing module {module}")]
    MissingClientReferenceModule { reference: String, module: String },
    #[error("client reference {reference} references non-client module {module}")]
    InvalidClientReferenceModuleKind { reference: String, module: String },
    #[error("client reference {reference} has an unsafe source path: {path}")]
    InvalidClientReferencePath { reference: String, path: PathBuf },
    #[error("client reference {reference} source path does not match module {module}")]
    ClientReferenceSourceMismatch { reference: String, module: String },
    #[error("client reference {reference} has an invalid export name: {export}")]
    InvalidClientReferenceExport { reference: String, export: String },
    #[error("client reference {reference} id does not match module/export identity")]
    InvalidClientReferenceId { reference: String },
    #[error("client reference {reference} chunk does not match module {module}")]
    ClientReferenceChunkMismatch { reference: String, module: String },
    #[error("route {route} has an unsafe source path: {path}")]
    InvalidRouteSource { route: String, path: PathBuf },
    #[error("route {route} source path does not match module {module}")]
    RouteSourceMismatch { route: String, module: String },
    #[error("action {action} source path does not match module {module}")]
    ActionSourceMismatch { action: String, module: String },
    #[error("duplicate module identifier: {0}")]
    DuplicateModule(String),
    #[error("duplicate layout identifier: {0}")]
    DuplicateLayout(String),
    #[error("duplicate action identifier: {0}")]
    DuplicateAction(String),
    #[error("duplicate client reference identifier: {0}")]
    DuplicateClientReference(String),
    #[error("duplicate asset URL path: {0}")]
    DuplicateAsset(String),
    #[error("asset URL path must be absolute and safe: {0}")]
    InvalidAssetPath(String),
    #[error("asset source path must be relative and safe: {0}")]
    InvalidAssetSource(PathBuf),
    #[error("route {route} has invalid method set")]
    InvalidRouteMethods { route: String },
    #[error("route {route} has invalid cache policy")]
    InvalidRouteCachePolicy { route: String },
}

#[derive(Debug)]
pub struct CompiledManifest {
    manifest: ApplicationManifest,
    router: Router,
    route_indexes: BTreeMap<String, usize>,
    asset_indexes: BTreeMap<String, usize>,
    action_indexes: BTreeMap<String, usize>,
    client_reference_indexes: BTreeMap<String, usize>,
}

#[derive(Debug)]
pub struct ManifestMatch<'a> {
    pub route: &'a RouteEntry,
    pub params: BTreeMap<String, Param>,
}

impl CompiledManifest {
    pub fn load(path: &Path) -> Result<Self, ManifestError> {
        let text = fs::read_to_string(path).map_err(|source| ManifestError::Read {
            path: path.to_owned(),
            source,
        })?;
        let manifest = ApplicationManifest::from_manifest_json(&text).map_err(|source| {
            ManifestError::Parse {
                path: path.to_owned(),
                source,
            }
        })?;
        Self::new(manifest)
    }

    pub fn new(manifest: ApplicationManifest) -> Result<Self, ManifestError> {
        let mut module_ids = BTreeSet::new();
        for module in &manifest.modules {
            if !module_ids.insert(module.id.clone()) {
                return Err(ManifestError::DuplicateModule(module.id.clone()));
            }
            if !is_safe_manifest_path(&module.path) {
                return Err(ManifestError::InvalidModulePath {
                    module: module.id.clone(),
                    path: module.path.clone(),
                });
            }
        }
        let modules = manifest
            .modules
            .iter()
            .map(|module| (module.id.clone(), module))
            .collect::<BTreeMap<_, _>>();

        let mut layout_ids = BTreeSet::new();
        for layout in &manifest.layouts {
            if !layout_ids.insert(layout.id.clone()) {
                return Err(ManifestError::DuplicateLayout(layout.id.clone()));
            }
            if !is_safe_manifest_path(&layout.path) {
                return Err(ManifestError::InvalidLayoutPath {
                    layout: layout.id.clone(),
                    path: layout.path.clone(),
                });
            }
        }
        let layouts = manifest
            .layouts
            .iter()
            .map(|layout| (layout.id.clone(), layout))
            .collect::<BTreeMap<_, _>>();

        let mut action_ids = BTreeSet::new();
        for action in &manifest.actions {
            if !action_ids.insert(action.id.clone()) {
                return Err(ManifestError::DuplicateAction(action.id.clone()));
            }
            if !is_safe_manifest_path(&action.path) {
                return Err(ManifestError::InvalidActionPath {
                    action: action.id.clone(),
                    path: action.path.clone(),
                });
            }
            if !is_valid_action_export(&action.export) {
                return Err(ManifestError::InvalidActionExport {
                    action: action.id.clone(),
                    export: action.export.clone(),
                });
            }
        }

        if let Some(action_proxy) = &manifest.action_proxy {
            if !is_safe_manifest_path(action_proxy) {
                return Err(ManifestError::InvalidActionProxyPath {
                    path: action_proxy.clone(),
                });
            }
        }

        let mut client_reference_ids = BTreeSet::new();
        for reference in &manifest.client_references {
            if !client_reference_ids.insert(reference.id.clone()) {
                return Err(ManifestError::DuplicateClientReference(
                    reference.id.clone(),
                ));
            }
            if !is_safe_manifest_path(&reference.path) {
                return Err(ManifestError::InvalidClientReferencePath {
                    reference: reference.id.clone(),
                    path: reference.path.clone(),
                });
            }
            if !is_valid_client_reference_export(&reference.export) {
                return Err(ManifestError::InvalidClientReferenceExport {
                    reference: reference.id.clone(),
                    export: reference.export.clone(),
                });
            }
            if !is_safe_manifest_path(&reference.browser_chunk) {
                return Err(ManifestError::InvalidBundlePath {
                    module: reference.module.clone(),
                    path: reference.browser_chunk.clone(),
                });
            }
        }

        let client_reference_lookup = manifest
            .client_references
            .iter()
            .map(|reference| (reference.id.clone(), reference))
            .collect::<BTreeMap<_, _>>();

        let mut asset_paths = BTreeSet::new();
        for asset in &manifest.assets {
            if !is_safe_asset_url(&asset.url_path) {
                return Err(ManifestError::InvalidAssetPath(asset.url_path.clone()));
            }
            if !is_safe_asset_source(&asset.source) {
                return Err(ManifestError::InvalidAssetSource(asset.source.clone()));
            }
            if !asset_paths.insert(asset.url_path.clone()) {
                return Err(ManifestError::DuplicateAsset(asset.url_path.clone()));
            }
        }

        for module in &manifest.modules {
            match (&module.kind, &module.server_bundle) {
                (ModuleKind::Client, Some(_)) => {
                    return Err(ManifestError::UnexpectedClientServerBundle {
                        module: module.id.clone(),
                    });
                }
                (ModuleKind::Client, None) => {
                    if module.browser_chunk.is_none() {
                        return Err(ManifestError::MissingBrowserChunk {
                            module: module.id.clone(),
                        });
                    }
                }
                (_, Some(path)) if path.as_os_str().is_empty() => {
                    return Err(ManifestError::EmptyServerBundle {
                        module: module.id.clone(),
                    });
                }
                (_, Some(path)) => {
                    if !is_safe_manifest_path(path) {
                        return Err(ManifestError::InvalidBundlePath {
                            module: module.id.clone(),
                            path: path.clone(),
                        });
                    }
                }
                (_, None) => {
                    return Err(ManifestError::MissingServerBundle {
                        module: module.id.clone(),
                    });
                }
            }
            if let Some(path) = &module.browser_chunk {
                if !is_safe_manifest_path(path) {
                    return Err(ManifestError::InvalidBundlePath {
                        module: module.id.clone(),
                        path: path.clone(),
                    });
                }
            }
        }

        for route in &manifest.routes {
            if !is_safe_manifest_path(&route.source) {
                return Err(ManifestError::InvalidRouteSource {
                    route: route.id.clone(),
                    path: route.source.clone(),
                });
            }
            let Some(module) = modules.get(&route.module) else {
                return Err(ManifestError::MissingRouteModule {
                    route: route.id.clone(),
                    module: route.module.clone(),
                });
            };
            if module.kind != ModuleKind::Server {
                return Err(ManifestError::InvalidRouteModuleKind {
                    route: route.id.clone(),
                    module: module.id.clone(),
                });
            }
            if route.source != module.path {
                return Err(ManifestError::RouteSourceMismatch {
                    route: route.id.clone(),
                    module: module.id.clone(),
                });
            }
            if module.server_bundle.is_none() {
                return Err(ManifestError::MissingServerBundle {
                    module: module.id.clone(),
                });
            }
            if !is_valid_route_methods(route) {
                return Err(ManifestError::InvalidRouteMethods {
                    route: route.id.clone(),
                });
            }
            if !is_valid_cache_policy(&route.cache) {
                return Err(ManifestError::InvalidRouteCachePolicy {
                    route: route.id.clone(),
                });
            }
            for layout in &route.layouts {
                if !layouts.contains_key(layout) {
                    return Err(ManifestError::MissingLayout {
                        route: route.id.clone(),
                        layout: layout.clone(),
                    });
                }
            }
            let mut route_client_references = BTreeSet::new();
            for reference in &route.client_references {
                if !route_client_references.insert(reference.clone()) {
                    return Err(ManifestError::DuplicateRouteClientReference {
                        route: route.id.clone(),
                        reference: reference.clone(),
                    });
                }
                if !client_reference_lookup.contains_key(reference) {
                    return Err(ManifestError::MissingRouteClientReference {
                        route: route.id.clone(),
                        reference: reference.clone(),
                    });
                }
            }
        }

        for action in &manifest.actions {
            let Some(module) = modules.get(&action.module) else {
                return Err(ManifestError::MissingActionModule {
                    action: action.id.clone(),
                    module: action.module.clone(),
                });
            };
            if module.kind != ModuleKind::ServerActions {
                return Err(ManifestError::InvalidActionModuleKind {
                    action: action.id.clone(),
                    module: module.id.clone(),
                });
            }
            if action.path != module.path {
                return Err(ManifestError::ActionSourceMismatch {
                    action: action.id.clone(),
                    module: module.id.clone(),
                });
            }
            if module.server_bundle.is_none() {
                return Err(ManifestError::MissingServerBundle {
                    module: module.id.clone(),
                });
            }
            if action.id != stable_action_id(&action.module, &action.export) {
                return Err(ManifestError::InvalidActionId {
                    action: action.id.clone(),
                });
            }
        }

        for reference in &manifest.client_references {
            let Some(module) = modules.get(&reference.module) else {
                return Err(ManifestError::MissingClientReferenceModule {
                    reference: reference.id.clone(),
                    module: reference.module.clone(),
                });
            };
            if module.kind != ModuleKind::Client {
                return Err(ManifestError::InvalidClientReferenceModuleKind {
                    reference: reference.id.clone(),
                    module: module.id.clone(),
                });
            }
            if reference.path != module.path {
                return Err(ManifestError::ClientReferenceSourceMismatch {
                    reference: reference.id.clone(),
                    module: module.id.clone(),
                });
            }
            let Some(browser_chunk) = &module.browser_chunk else {
                return Err(ManifestError::MissingBrowserChunk {
                    module: module.id.clone(),
                });
            };
            if reference.browser_chunk != *browser_chunk {
                return Err(ManifestError::ClientReferenceChunkMismatch {
                    reference: reference.id.clone(),
                    module: module.id.clone(),
                });
            }
            if reference.id != stable_client_reference_id(&reference.module, &reference.export) {
                return Err(ManifestError::InvalidClientReferenceId {
                    reference: reference.id.clone(),
                });
            }
        }

        let runtime_routes = manifest
            .routes
            .iter()
            .map(|entry| RuntimeRoute::parse(entry.id.clone(), &entry.pattern))
            .collect::<Result<Vec<_>, _>>()?;
        let router = Router::new(runtime_routes)?;
        let route_indexes = manifest
            .routes
            .iter()
            .enumerate()
            .map(|(index, route)| (route.id.clone(), index))
            .collect();
        let asset_indexes = manifest
            .assets
            .iter()
            .enumerate()
            .map(|(index, asset)| (asset.url_path.clone(), index))
            .collect();
        let action_indexes = manifest
            .actions
            .iter()
            .enumerate()
            .map(|(index, action)| (action.id.clone(), index))
            .collect();
        let client_reference_indexes = manifest
            .client_references
            .iter()
            .enumerate()
            .map(|(index, reference)| (reference.id.clone(), index))
            .collect();

        Ok(Self {
            manifest,
            router,
            route_indexes,
            asset_indexes,
            action_indexes,
            client_reference_indexes,
        })
    }

    pub fn manifest(&self) -> &ApplicationManifest {
        &self.manifest
    }

    pub fn asset(&self, path: &str) -> Option<&AssetRef> {
        self.asset_indexes
            .get(path)
            .map(|index| &self.manifest.assets[*index])
    }

    pub fn resolve_asset_source(
        &self,
        public_root: &Path,
        asset: &AssetRef,
    ) -> Result<PathBuf, ManifestError> {
        if !is_safe_asset_source(&asset.source) {
            return Err(ManifestError::InvalidAssetSource(asset.source.clone()));
        }
        Ok(public_root.join(&asset.source))
    }

    pub fn action(&self, id: &str) -> Option<&ActionRef> {
        self.action_indexes
            .get(id)
            .map(|index| &self.manifest.actions[*index])
    }

    pub fn action_proxy(&self) -> Option<&Path> {
        self.manifest.action_proxy.as_deref()
    }

    pub fn client_reference(&self, id: &str) -> Option<&ClientReference> {
        self.client_reference_indexes
            .get(id)
            .map(|index| &self.manifest.client_references[*index])
    }

    pub fn route_hydration(&self, route: &RouteEntry) -> Result<RouteHydration, ManifestError> {
        let mut browser_chunks = BTreeSet::new();
        let mut client_references = Vec::with_capacity(route.client_references.len());
        for id in &route.client_references {
            let Some(reference) = self.client_reference(id) else {
                return Err(ManifestError::MissingRouteClientReference {
                    route: route.id.clone(),
                    reference: id.clone(),
                });
            };
            browser_chunks.insert(reference.browser_chunk.clone());
            client_references.push(ClientHydrationReference {
                id: reference.id.clone(),
                module: reference.module.clone(),
                export: reference.export.clone(),
                browser_chunk: reference.browser_chunk.clone(),
            });
        }
        if let Some(action_proxy) = &self.manifest.action_proxy {
            browser_chunks.insert(action_proxy.clone());
        }
        Ok(RouteHydration {
            client_references,
            browser_chunks: browser_chunks.into_iter().collect(),
        })
    }

    pub fn module(&self, id: &str) -> Option<&ModuleRef> {
        self.manifest.modules.iter().find(|module| module.id == id)
    }

    pub fn resolve(&self, path: &str) -> Result<Option<ManifestMatch<'_>>, ManifestError> {
        let Some(matched) = self.router.resolve(path)? else {
            return Ok(None);
        };
        let index = self.route_indexes[&matched.route.id];
        Ok(Some(ManifestMatch {
            route: &self.manifest.routes[index],
            params: matched.params,
        }))
    }
}

fn is_valid_cache_policy(policy: &CachePolicy) -> bool {
    !(policy.dynamic == DynamicPolicy::ForceDynamic && policy.revalidate_seconds.is_some())
}

fn is_valid_action_export(export: &str) -> bool {
    is_valid_export_name(export) && export != "default"
}

fn is_valid_client_reference_export(export: &str) -> bool {
    export == "default" || is_valid_export_name(export)
}

fn is_valid_export_name(export: &str) -> bool {
    let mut chars = export.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn stable_action_id(module: &str, export: &str) -> String {
    format!("action:{module}#{export}")
}

fn stable_client_reference_id(module: &str, export: &str) -> String {
    format!("client:{module}#{export}")
}

fn is_valid_route_methods(route: &RouteEntry) -> bool {
    const HANDLER_METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

    if route.methods.is_empty() {
        return false;
    }
    let mut seen = BTreeSet::new();
    for method in &route.methods {
        if !HANDLER_METHODS.contains(&method.as_str()) || !seen.insert(method) {
            return false;
        }
    }
    match route.kind {
        RouteKind::Page => route.methods == ["GET", "HEAD"],
        RouteKind::Handler => true,
    }
}

fn is_safe_asset_url(path: &str) -> bool {
    path.starts_with('/')
        && path != "/"
        && path.len() <= 16 * 1024
        && path.chars().all(|character| {
            character.is_ascii()
                && !character.is_ascii_control()
                && !character.is_ascii_whitespace()
        })
        && !path.contains(['?', '#', '\\'])
        && !path
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .any(|part| part == "." || part == ".." || part.contains('%'))
}

fn is_safe_manifest_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_safe_asset_source(path: &Path) -> bool {
    is_safe_manifest_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ApplicationManifest {
        ApplicationManifest {
            routes: vec![RouteEntry {
                id: "shop/_id_/page".into(),
                pattern: "/shop/[id]".into(),
                kind: RouteKind::Page,
                source: PathBuf::from("shop/[id]/page.tsx"),
                layouts: vec!["layout".into()],
                module: "shop/_id_/page".into(),
                methods: vec!["GET".into(), "HEAD".into()],
                cache: CachePolicy::default(),
                client_references: vec!["client:shop/_id_/counter#Counter".into()],
            }],
            layouts: vec![LayoutRef {
                id: "layout".into(),
                path: PathBuf::from("layout.tsx"),
                depth: 0,
            }],
            modules: vec![
                ModuleRef {
                    id: "shop/_id_/page".into(),
                    path: PathBuf::from("shop/[id]/page.tsx"),
                    kind: ModuleKind::Server,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/shop/_id_/page.js")),
                },
                ModuleRef {
                    id: "shop/_id_/actions".into(),
                    path: PathBuf::from("shop/[id]/actions.ts"),
                    kind: ModuleKind::ServerActions,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/shop/_id_/actions.js")),
                },
                ModuleRef {
                    id: "shop/_id_/counter".into(),
                    path: PathBuf::from("shop/[id]/counter.tsx"),
                    kind: ModuleKind::Client,
                    browser_chunk: Some(PathBuf::from(".zap/browser/shop/_id_/counter.js")),
                    server_bundle: None,
                },
            ],
            actions: vec![ActionRef {
                id: "action:shop/_id_/actions#save".into(),
                module: "shop/_id_/actions".into(),
                export: "save".into(),
                path: PathBuf::from("shop/[id]/actions.ts"),
            }],
            action_proxy: Some(PathBuf::from(".zap/browser/actions.js")),
            client_references: vec![ClientReference {
                id: "client:shop/_id_/counter#Counter".into(),
                module: "shop/_id_/counter".into(),
                export: "Counter".into(),
                path: PathBuf::from("shop/[id]/counter.tsx"),
                browser_chunk: PathBuf::from(".zap/browser/shop/_id_/counter.js"),
            }],
            assets: vec![AssetRef {
                source: PathBuf::from("images/logo.svg"),
                url_path: "/images/logo.svg".into(),
            }],
        }
    }

    #[test]
    fn compiles_manifest_and_resolves_route_metadata() {
        let compiled = CompiledManifest::new(manifest()).unwrap();
        let matched = compiled.resolve("/shop/caf%C3%A9").unwrap().unwrap();
        assert_eq!(matched.route.module, "shop/_id_/page");
        assert_eq!(matched.params["id"], Param::One("café".into()));
        assert_eq!(
            compiled
                .action("action:shop/_id_/actions#save")
                .unwrap()
                .export,
            "save"
        );
        assert_eq!(
            compiled
                .client_reference("client:shop/_id_/counter#Counter")
                .unwrap()
                .browser_chunk,
            PathBuf::from(".zap/browser/shop/_id_/counter.js")
        );
        assert_eq!(
            compiled.action_proxy().unwrap(),
            Path::new(".zap/browser/actions.js")
        );
        let hydration = compiled.route_hydration(matched.route).unwrap();
        assert_eq!(
            hydration.browser_chunks,
            vec![
                PathBuf::from(".zap/browser/actions.js"),
                PathBuf::from(".zap/browser/shop/_id_/counter.js")
            ]
        );
        assert_eq!(hydration.client_references[0].export, "Counter");
        let asset = compiled.asset("/images/logo.svg").unwrap();
        assert_eq!(
            compiled
                .resolve_asset_source(Path::new("/app/public"), asset)
                .unwrap(),
            PathBuf::from("/app/public/images/logo.svg")
        );
    }

    #[test]
    fn rejects_broken_manifest_references() {
        let mut manifest = manifest();
        manifest.routes[0].module = "missing".into();
        let error = CompiledManifest::new(manifest).unwrap_err().to_string();
        assert!(error.contains("missing module"), "{error}");
    }

    #[test]
    fn rejects_duplicate_and_unsafe_manifest_entries() {
        let mut duplicate_module = manifest();
        duplicate_module
            .modules
            .push(duplicate_module.modules[0].clone());
        assert!(matches!(
            CompiledManifest::new(duplicate_module).unwrap_err(),
            ManifestError::DuplicateModule(_)
        ));

        let mut unsafe_asset = manifest();
        unsafe_asset.assets.push(AssetRef {
            source: PathBuf::from("secret"),
            url_path: "/../secret".into(),
        });
        assert!(matches!(
            CompiledManifest::new(unsafe_asset).unwrap_err(),
            ManifestError::InvalidAssetPath(_)
        ));

        let mut root_asset = manifest();
        root_asset.assets[0].url_path = "/".into();
        assert!(matches!(
            CompiledManifest::new(root_asset).unwrap_err(),
            ManifestError::InvalidAssetPath(_)
        ));

        let mut whitespace_asset = manifest();
        whitespace_asset.assets[0].url_path = "/images/logo mark.svg".into();
        assert!(matches!(
            CompiledManifest::new(whitespace_asset).unwrap_err(),
            ManifestError::InvalidAssetPath(_)
        ));

        let mut unicode_asset = manifest();
        unicode_asset.assets[0].url_path = "/images/café.svg".into();
        assert!(matches!(
            CompiledManifest::new(unicode_asset).unwrap_err(),
            ManifestError::InvalidAssetPath(_)
        ));

        let mut absolute_source = manifest();
        absolute_source.assets[0].source = PathBuf::from("/etc/passwd");
        assert!(matches!(
            CompiledManifest::new(absolute_source).unwrap_err(),
            ManifestError::InvalidAssetSource(_)
        ));

        let mut traversal_source = manifest();
        traversal_source.assets[0].source = PathBuf::from("../secret");
        assert!(matches!(
            CompiledManifest::new(traversal_source).unwrap_err(),
            ManifestError::InvalidAssetSource(_)
        ));

        let mut unsafe_module_path = manifest();
        unsafe_module_path.modules[0].path = PathBuf::from("../page.tsx");
        assert!(matches!(
            CompiledManifest::new(unsafe_module_path).unwrap_err(),
            ManifestError::InvalidModulePath { .. }
        ));

        let mut unsafe_server_bundle = manifest();
        unsafe_server_bundle.modules[0].server_bundle = Some(PathBuf::from("/tmp/page.js"));
        assert!(matches!(
            CompiledManifest::new(unsafe_server_bundle).unwrap_err(),
            ManifestError::InvalidBundlePath { .. }
        ));

        let mut unsafe_route_source = manifest();
        unsafe_route_source.routes[0].source = PathBuf::from("../page.tsx");
        assert!(matches!(
            CompiledManifest::new(unsafe_route_source).unwrap_err(),
            ManifestError::InvalidRouteSource { .. }
        ));

        let mut mismatched_route_source = manifest();
        mismatched_route_source.routes[0].source = PathBuf::from("other/page.tsx");
        assert!(matches!(
            CompiledManifest::new(mismatched_route_source).unwrap_err(),
            ManifestError::RouteSourceMismatch { .. }
        ));

        let mut unsafe_layout_path = manifest();
        unsafe_layout_path.layouts[0].path = PathBuf::from("../layout.tsx");
        assert!(matches!(
            CompiledManifest::new(unsafe_layout_path).unwrap_err(),
            ManifestError::InvalidLayoutPath { .. }
        ));

        let mut unsafe_action_path = manifest();
        unsafe_action_path.actions[0].path = PathBuf::from("../actions.ts");
        assert!(matches!(
            CompiledManifest::new(unsafe_action_path).unwrap_err(),
            ManifestError::InvalidActionPath { .. }
        ));

        let mut mismatched_action_path = manifest();
        mismatched_action_path.actions[0].path = PathBuf::from("other/actions.ts");
        assert!(matches!(
            CompiledManifest::new(mismatched_action_path).unwrap_err(),
            ManifestError::ActionSourceMismatch { .. }
        ));

        let mut client_server_bundle = manifest();
        client_server_bundle.modules[0].kind = ModuleKind::Client;
        client_server_bundle.modules[0].browser_chunk = Some(PathBuf::from(".zap/browser/page.js"));
        assert!(matches!(
            CompiledManifest::new(client_server_bundle).unwrap_err(),
            ManifestError::UnexpectedClientServerBundle { .. }
        ));

        let mut invalid_action_module = manifest();
        invalid_action_module.actions[0].module = "shop/_id_/page".into();
        assert!(matches!(
            CompiledManifest::new(invalid_action_module).unwrap_err(),
            ManifestError::InvalidActionModuleKind { .. }
        ));

        let mut invalid_action_export = manifest();
        invalid_action_export.actions[0].export = "1save".into();
        invalid_action_export.actions[0].id = "action:shop/_id_/actions#1save".into();
        assert!(matches!(
            CompiledManifest::new(invalid_action_export).unwrap_err(),
            ManifestError::InvalidActionExport { .. }
        ));

        let mut invalid_action_id = manifest();
        invalid_action_id.actions[0].id = "save".into();
        assert!(matches!(
            CompiledManifest::new(invalid_action_id).unwrap_err(),
            ManifestError::InvalidActionId { .. }
        ));

        let mut unsafe_action_proxy = manifest();
        unsafe_action_proxy.action_proxy = Some(PathBuf::from("../actions.js"));
        assert!(matches!(
            CompiledManifest::new(unsafe_action_proxy).unwrap_err(),
            ManifestError::InvalidActionProxyPath { .. }
        ));

        let mut duplicate_client_reference = manifest();
        duplicate_client_reference
            .client_references
            .push(duplicate_client_reference.client_references[0].clone());
        assert!(matches!(
            CompiledManifest::new(duplicate_client_reference).unwrap_err(),
            ManifestError::DuplicateClientReference(_)
        ));

        let mut missing_route_client_reference = manifest();
        missing_route_client_reference.routes[0].client_references[0] =
            "client:missing#Counter".into();
        assert!(matches!(
            CompiledManifest::new(missing_route_client_reference).unwrap_err(),
            ManifestError::MissingRouteClientReference { .. }
        ));

        let mut duplicate_route_client_reference = manifest();
        duplicate_route_client_reference.routes[0]
            .client_references
            .push("client:shop/_id_/counter#Counter".into());
        assert!(matches!(
            CompiledManifest::new(duplicate_route_client_reference).unwrap_err(),
            ManifestError::DuplicateRouteClientReference { .. }
        ));

        let mut invalid_client_reference_module = manifest();
        invalid_client_reference_module.client_references[0].module = "shop/_id_/page".into();
        assert!(matches!(
            CompiledManifest::new(invalid_client_reference_module).unwrap_err(),
            ManifestError::InvalidClientReferenceModuleKind { .. }
        ));

        let mut invalid_client_reference_id = manifest();
        invalid_client_reference_id.client_references[0].id = "Counter".into();
        invalid_client_reference_id.routes[0].client_references[0] = "Counter".into();
        assert!(matches!(
            CompiledManifest::new(invalid_client_reference_id).unwrap_err(),
            ManifestError::InvalidClientReferenceId { .. }
        ));

        let mut mismatched_client_reference_chunk = manifest();
        mismatched_client_reference_chunk.client_references[0].browser_chunk =
            PathBuf::from(".zap/browser/other.js");
        assert!(matches!(
            CompiledManifest::new(mismatched_client_reference_chunk).unwrap_err(),
            ManifestError::ClientReferenceChunkMismatch { .. }
        ));

        let mut invalid_route_module = manifest();
        invalid_route_module.modules[0].kind = ModuleKind::ServerActions;
        assert!(matches!(
            CompiledManifest::new(invalid_route_module).unwrap_err(),
            ManifestError::InvalidRouteModuleKind { .. }
        ));

        let mut invalid_handler_method = manifest();
        invalid_handler_method.routes[0].kind = RouteKind::Handler;
        invalid_handler_method.routes[0].methods = vec!["BREW".into()];
        assert!(matches!(
            CompiledManifest::new(invalid_handler_method).unwrap_err(),
            ManifestError::InvalidRouteMethods { .. }
        ));

        let mut duplicate_handler_method = manifest();
        duplicate_handler_method.routes[0].kind = RouteKind::Handler;
        duplicate_handler_method.routes[0].methods = vec!["POST".into(), "POST".into()];
        assert!(matches!(
            CompiledManifest::new(duplicate_handler_method).unwrap_err(),
            ManifestError::InvalidRouteMethods { .. }
        ));

        let mut invalid_cache_policy = manifest();
        invalid_cache_policy.routes[0].cache = CachePolicy {
            dynamic: DynamicPolicy::ForceDynamic,
            revalidate_seconds: Some(60),
        };
        assert!(matches!(
            CompiledManifest::new(invalid_cache_policy).unwrap_err(),
            ManifestError::InvalidRouteCachePolicy { .. }
        ));
    }
}
