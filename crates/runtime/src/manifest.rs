use crate::routing::{Param, Route as RuntimeRoute, RouteError, Router};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
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
    pub server_bundle: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionRef {
    pub id: String,
    pub module: String,
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
    #[error("route {route} references missing layout {layout}")]
    MissingLayout { route: String, layout: String },
    #[error("action {action} references missing module {module}")]
    MissingActionModule { action: String, module: String },
    #[error("module {module} has an empty server bundle path")]
    EmptyServerBundle { module: String },
    #[error("client module {module} is missing a browser chunk")]
    MissingBrowserChunk { module: String },
}

#[derive(Debug)]
pub struct CompiledManifest {
    manifest: ApplicationManifest,
    router: Router,
    route_indexes: BTreeMap<String, usize>,
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
        let modules = manifest
            .modules
            .iter()
            .map(|module| (module.id.clone(), module))
            .collect::<BTreeMap<_, _>>();
        let layouts = manifest
            .layouts
            .iter()
            .map(|layout| (layout.id.clone(), layout))
            .collect::<BTreeMap<_, _>>();

        for module in &manifest.modules {
            if module.server_bundle.as_os_str().is_empty() {
                return Err(ManifestError::EmptyServerBundle {
                    module: module.id.clone(),
                });
            }
            if module.kind == ModuleKind::Client && module.browser_chunk.is_none() {
                return Err(ManifestError::MissingBrowserChunk {
                    module: module.id.clone(),
                });
            }
        }

        for route in &manifest.routes {
            if !modules.contains_key(&route.module) {
                return Err(ManifestError::MissingRouteModule {
                    route: route.id.clone(),
                    module: route.module.clone(),
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
            if !modules.contains_key(&action.module) {
                return Err(ManifestError::MissingActionModule {
                    action: action.id.clone(),
                    module: action.module.clone(),
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

        Ok(Self {
            manifest,
            router,
            route_indexes,
        })
    }

    pub fn manifest(&self) -> &ApplicationManifest {
        &self.manifest
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
                cache: CachePolicy::default(),
            }],
            layouts: vec![LayoutRef {
                id: "layout".into(),
                path: PathBuf::from("layout.tsx"),
                depth: 0,
            }],
            modules: vec![ModuleRef {
                id: "shop/_id_/page".into(),
                path: PathBuf::from("shop/[id]/page.tsx"),
                kind: ModuleKind::Server,
                browser_chunk: None,
                server_bundle: PathBuf::from(".zap/server/shop/_id_/page.js"),
            }],
            actions: Vec::new(),
            assets: Vec::new(),
        }
    }

    #[test]
    fn compiles_manifest_and_resolves_route_metadata() {
        let compiled = CompiledManifest::new(manifest()).unwrap();
        let matched = compiled.resolve("/shop/caf%C3%A9").unwrap().unwrap();
        assert_eq!(matched.route.module, "shop/_id_/page");
        assert_eq!(matched.params["id"], Param::One("café".into()));
    }

    #[test]
    fn rejects_broken_manifest_references() {
        let mut manifest = manifest();
        manifest.routes[0].module = "missing".into();
        let error = CompiledManifest::new(manifest).unwrap_err().to_string();
        assert!(error.contains("missing module"), "{error}");
    }
}
