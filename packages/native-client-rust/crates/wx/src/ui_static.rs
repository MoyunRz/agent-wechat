//! Static hosting of the bundled chat UI under `/ui/`.
//!
//! The UI directory is supplied through the `WX_UI_DIR` environment variable
//! when it exists. Hosting lives outside the authenticated API surface: the
//! bundle contains no secrets, and every authenticated call the page makes
//! carries its own Bearer token.

use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub type UiDir = Arc<PathBuf>;

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn is_immutable_asset(path: &Path) -> bool {
    // Build output carries content hashes in file names; everything else
    // (index.html in particular) must be revalidated so upgrades are picked up.
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext,
                "js" | "mjs"
                    | "css"
                    | "woff"
                    | "woff2"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "svg"
                    | "webp"
                    | "gif"
                    | "ico"
            )
        })
}

fn serve_file(root: &Path, relative: &str) -> Response {
    if relative.is_empty() || relative.split(['/', '\\']).any(|segment| segment == "..") {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let path = root.join(relative);
    let (Ok(canonical_root), Ok(canonical)) = (root.canonicalize(), path.canonicalize()) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match std::fs::read(&canonical) {
        Ok(bytes) => {
            let cache = if is_immutable_asset(&canonical) {
                "public, max-age=3600"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, content_type(&canonical)),
                    (header::CACHE_CONTROL, cache),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Routes served outside the authenticated API surface: `/ui`, `/ui/` and
/// `/ui/{rest}` resolve inside the UI bundle directory.
pub fn ui_routes(dir: PathBuf) -> Router {
    let state: UiDir = Arc::new(dir);
    Router::new()
        .route("/ui", get(ui_index))
        .route("/ui/", get(ui_index))
        .route("/ui/{*rest}", get(ui_asset))
        .with_state(state)
}

async fn ui_index(State(root): State<UiDir>) -> Response {
    serve_file(&root, "index.html")
}

async fn ui_asset(State(root): State<UiDir>, AxumPath(rest): AxumPath<String>) -> Response {
    serve_file(&root, &rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn bundle() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<html>ui</html>").unwrap();
        std::fs::write(root.join("assets/app-a1b2.js"), "console.log(1)").unwrap();
        (temp, root)
    }

    async fn get(router: Router, path: &str) -> Response {
        let response = router
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        Response::from_parts(parts, body)
    }

    #[tokio::test]
    async fn serves_index_assets_and_rejects_traversal() {
        let (_temp, root) = bundle();
        let router = ui_routes(root);

        let index = get(router.clone(), "/ui/").await;
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(
            index.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(index.headers()[header::CACHE_CONTROL], "no-cache");

        let asset = get(router.clone(), "/ui/assets/app-a1b2.js").await;
        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(
            asset.headers()[header::CACHE_CONTROL],
            "public, max-age=3600"
        );

        let missing = get(router.clone(), "/ui/assets/missing.js").await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        for traversal in [
            "/ui/../main.rs",
            "/ui/%2e%2e/main.rs",
            "/ui/assets/../index.html",
        ] {
            let blocked = get(router.clone(), traversal).await;
            assert_eq!(blocked.status(), StatusCode::NOT_FOUND, "{traversal}");
        }
        let root_index = get(router, "/ui").await;
        assert_eq!(root_index.status(), StatusCode::OK);
    }

    #[test]
    fn serve_file_rejects_missing_bundle() {
        let response = serve_file(Path::new("definitely-missing-dir"), "index.html");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
