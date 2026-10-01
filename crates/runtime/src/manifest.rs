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
    #[error("route {route} has an unsafe source path: {path}")]
    InvalidRouteSource { route: String, path: PathBuf },
    #[error("duplicate module identifier: {0}")]
    DuplicateModule(String),
    #[error("duplicate layout identifier: {0}")]
    DuplicateLayout(String),
    #[error("duplicate action identifier: {0}")]
    DuplicateAction(String),
    #[error("duplicate asset URL path: {0}")]
    DuplicateAsset(String),
    #[error("asset URL path must be absolute and safe: {0}")]
    InvalidAssetPath(String),
    #[error("asset source path must be relative and safe: {0}")]
    InvalidAssetSource(PathBuf),
    #[error("route {route} has invalid method set")]
    InvalidRouteMethods { route: String },
}

#[derive(Debug)]
pub struct CompiledManifest {
    manifest: ApplicationManifest,
    router: Router,
    route_indexes: BTreeMap<String, usize>,
    asset_indexes: BTreeMap<String, usize>,
    action_indexes: BTreeMap<String, usize>,
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
        }

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
            for layout in &route.layouts {
                if !layouts.contains_key(layout) {
                    return Err(ManifestError::MissingLayout {
                        route: route.id.clone(),
                        layout: layout.clone(),
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
            if module.server_bundle.is_none() {
                return Err(ManifestError::MissingServerBundle {
                    module: module.id.clone(),
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

        Ok(Self {
            manifest,
            router,
            route_indexes,
            asset_indexes,
            action_indexes,
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

fn is_valid_route_methods(route: &RouteEntry) -> bool {
    if route.methods.is_empty() {
        return false;
    }
    let mut seen = BTreeSet::new();
    for method in &route.methods {
        if method.is_empty()
            || !method
                .chars()
                .all(|character| character.is_ascii_uppercase())
            || !seen.insert(method)
        {
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
        && !path.is_empty()
        && path.len() <= 16 * 1024
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
            ],
            actions: vec![ActionRef {
                id: "action:shop/_id_/actions#save".into(),
                module: "shop/_id_/actions".into(),
                export: "save".into(),
                path: PathBuf::from("shop/[id]/actions.ts"),
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

        let mut invalid_route_module = manifest();
        invalid_route_module.modules[0].kind = ModuleKind::ServerActions;
        assert!(matches!(
            CompiledManifest::new(invalid_route_module).unwrap_err(),
            ManifestError::InvalidRouteModuleKind { .. }
        ));
    }
}
