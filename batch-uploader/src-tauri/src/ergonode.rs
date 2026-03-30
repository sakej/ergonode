use serde::{Deserialize, Serialize};

// ---------- Public types ----------

#[derive(Serialize, Deserialize, Clone)]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize)]
pub struct UploadResult {
    pub file_name: String,
    pub success: bool,
    pub error: Option<String>,
    pub rate_limited: bool,
}

// ---------- Internal GraphQL response types ----------

#[derive(Deserialize)]
struct GqlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize)]
struct GqlError {
    message: String,
    extensions: Option<GqlErrorExtensions>,
}

#[derive(Deserialize)]
struct GqlErrorExtensions {
    code: Option<String>,
    #[serde(rename = "errorCode")]
    error_code: Option<String>,
}

/// Extract the most useful error string from a GraphQL error.
/// Tries extensions.code / extensions.errorCode first, falls back to message.
fn extract_gql_error(error: &GqlError) -> String {
    if let Some(ext) = &error.extensions {
        if let Some(code) = ext.code.as_deref().or(ext.error_code.as_deref()) {
            if !code.is_empty() {
                return format!("{}: {}", code, error.message);
            }
        }
    }
    error.message.clone()
}

#[derive(Deserialize)]
struct FolderListData {
    #[serde(rename = "multimediaFolderList")]
    multimedia_folder_list: FolderListConnection,
}

#[derive(Deserialize)]
struct FolderListConnection {
    edges: Vec<FolderEdge>,
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Deserialize)]
struct FolderEdge {
    node: FolderNode,
    cursor: String,
}

#[derive(Deserialize)]
struct FolderNode {
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct PageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
}

// ---------- ErgonodeClient ----------

pub struct ErgonodeClient {
    client: reqwest::Client,
    api_url: String,
    api_key: String,
}

impl ErgonodeClient {
    pub fn new(api_url: &str, api_key: &str) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_url: api_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/api/graphql/", self.api_url)
    }

    /// Send a minimal query to verify the API key is valid.
    pub async fn test_connection(&self) -> Result<(), String> {
        let query = r#"{"query":"{ multimediaFolderList(first:1) { edges { node { name } } } }"}"#;

        let resp = self
            .client
            .post(self.endpoint())
            .header("X-API-KEY", &self.api_key)
            .header("Content-Type", "application/json")
            .body(query)
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err("Invalid API key".to_string());
        }
        if !status.is_success() {
            return Err(format!("Server returned status {status}"));
        }

        // Check for GraphQL-level errors
        let body: serde_json::Value = resp.json().await.map_err(|e| format!("Bad response: {e}"))?;
        if let Some(errors) = body.get("errors") {
            if let Some(arr) = errors.as_array() {
                if !arr.is_empty() {
                    let msg = arr[0]
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown GraphQL error");
                    return Err(format!("API error: {msg}"));
                }
            }
        }

        Ok(())
    }

    /// Fetch ALL folders using cursor-based pagination.
    pub async fn fetch_folders(&self) -> Result<Vec<FolderInfo>, String> {
        let mut folders = Vec::new();
        let mut after: Option<String> = None;

        loop {
            let query = match &after {
                Some(cursor) => format!(
                    r#"{{"query":"{{ multimediaFolderList(first:300, after:\"{cursor}\") {{ edges {{ node {{ name path }} cursor }} pageInfo {{ hasNextPage }} }} }}"}}"#
                ),
                None => r#"{"query":"{ multimediaFolderList(first:300) { edges { node { name path } cursor } pageInfo { hasNextPage } } }"}"#.to_string(),
            };

            let resp = self
                .client
                .post(self.endpoint())
                .header("X-API-KEY", &self.api_key)
                .header("Content-Type", "application/json")
                .body(query)
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;

            let status = resp.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Err("Rate limited (429). Please try again later.".to_string());
            }
            if !status.is_success() {
                return Err(format!("Server returned status {status}"));
            }

            let body: GqlResponse<FolderListData> =
                resp.json().await.map_err(|e| format!("Bad response: {e}"))?;

            if let Some(errors) = &body.errors {
                if let Some(first) = errors.first() {
                    return Err(format!("API error: {}", first.message));
                }
            }

            let data = body.data.ok_or("No data in response")?;
            let connection = data.multimedia_folder_list;

            let last_cursor = connection.edges.last().map(|e| e.cursor.clone());

            for edge in connection.edges {
                folders.push(FolderInfo {
                    name: edge.node.name,
                    path: edge.node.path,
                });
            }

            if connection.page_info.has_next_page {
                after = last_cursor;
            } else {
                break;
            }
        }

        Ok(folders)
    }

    /// Create a folder via the multimediaFolderCreate mutation.
    pub async fn create_folder(&self, name: &str, parent_path: Option<&str>) -> Result<(), String> {
        let escaped_name = name.replace('"', r#"\""#);

        let input = match parent_path {
            Some(p) if !p.is_empty() => {
                let escaped_path = p.replace('"', r#"\""#);
                format!(
                    r#"name:\"{escaped_name}\",folderPath:\"{escaped_path}\",createFolderPath:true"#
                )
            }
            _ => format!(r#"name:\"{escaped_name}\",createFolderPath:true"#),
        };

        let query = format!(
            r#"{{"query":"mutation {{ multimediaFolderCreate(input: {{ {input} }}) {{ __typename }} }}"}}"#
        );

        let resp = self
            .client
            .post(self.endpoint())
            .header("X-API-KEY", &self.api_key)
            .header("Content-Type", "application/json")
            .body(query)
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("Rate limited (429). Please try again later.".to_string());
        }
        if !status.is_success() {
            return Err(format!("Server returned status {status}"));
        }

        let body: serde_json::Value = resp.json().await.map_err(|e| format!("Bad response: {e}"))?;
        if let Some(errors) = body.get("errors") {
            if let Some(arr) = errors.as_array() {
                if !arr.is_empty() {
                    // Return the full raw JSON so callers can match on error codes (UUIDs)
                    return Err(arr[0].to_string());
                }
            }
        }

        Ok(())
    }

    /// Create multiple folders in order. "Already exists" errors are treated as success.
    /// `base_path` is the currently selected Ergonode folder (None = root).
    /// `relative_paths` is a list like ["winter", "winter/photos", "summer"].
    pub async fn create_folders_batch(
        &self,
        base_path: Option<&str>,
        relative_paths: &[String],
    ) -> Result<(), String> {
        // Sort by depth (parents first)
        let mut sorted = relative_paths.to_vec();
        sorted.sort_by_key(|p| p.chars().filter(|&c| c == '/').count());
        sorted.dedup();

        for rel_path in &sorted {
            // Build the full Ergonode path: base_path + "/" + rel_path
            let full_path = match base_path {
                Some(b) if !b.is_empty() => format!("{b}/{rel_path}"),
                _ => rel_path.clone(),
            };

            // Split into parent path and folder name
            let (parent, name) = if let Some(idx) = full_path.rfind('/') {
                (Some(&full_path[..idx]), &full_path[idx + 1..])
            } else {
                (None, full_path.as_str())
            };

            match self.create_folder(name, parent).await {
                Ok(_) => {}
                Err(e) => {
                    // "Folder already exists" UUID — treat as success
                    if e.contains("54c25a35") {
                        continue;
                    }
                    return Err(format!("Failed to create folder '{full_path}': {e}"));
                }
            }
        }

        Ok(())
    }

    /// Upload a file via multipart POST (multimediaCreate mutation).
    pub async fn upload_file(
        &self,
        file_path: &str,
        file_name: &str,
        folder_path: Option<&str>,
    ) -> UploadResult {
        let result = self.upload_file_inner(file_path, file_name, folder_path).await;
        match result {
            Ok(upload) => upload,
            Err(e) => UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some(e),
                rate_limited: false,
            },
        }
    }

    async fn upload_file_inner(
        &self,
        file_path: &str,
        file_name: &str,
        folder_path: Option<&str>,
    ) -> Result<UploadResult, String> {
        let file_bytes = tokio::fs::read(file_path)
            .await
            .map_err(|e| format!("Failed to read file: {e}"))?;

        let escaped_name = file_name.replace('"', r#"\""#);

        let mutation = match folder_path {
            Some(p) if !p.is_empty() => {
                let escaped_path = p.replace('"', r#"\""#);
                format!(
                    r#"mutation{{multimediaCreate(input:{{name:"{escaped_name}",folderPath:"{escaped_path}"}}){{__typename}}}}"#
                )
            }
            _ => format!(
                r#"mutation{{multimediaCreate(input:{{name:"{escaped_name}"}}){{__typename}}}}"#
            ),
        };

        let mime_type = mime_guess::from_path(file_name)
            .first_or_octet_stream()
            .to_string();

        let file_part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name.to_string())
            .mime_str(&mime_type)
            .map_err(|e| format!("MIME error: {e}"))?;

        let form = reqwest::multipart::Form::new()
            .part("upload", file_part)
            .text("query", mutation);

        let resp = self
            .client
            .post(self.endpoint())
            .header("X-API-KEY", &self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some("Rate limited (429)".to_string()),
                rate_limited: true,
            });
        }

        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Ok(UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some(format!("Status {status}: {body_text}")),
                rate_limited: false,
            });
        }

        let body: serde_json::Value =
            resp.json().await.map_err(|e| format!("Bad response: {e}"))?;

        // Pass the full raw error JSON so the frontend can parse it
        if let Some(errors_val) = body.get("errors") {
            if let Some(arr) = errors_val.as_array() {
                if !arr.is_empty() {
                    return Ok(UploadResult {
                        file_name: file_name.to_string(),
                        success: false,
                        error: Some(arr[0].to_string()),
                        rate_limited: false,
                    });
                }
            }
        }

        Ok(UploadResult {
            file_name: file_name.to_string(),
            success: true,
            error: None,
            rate_limited: false,
        })
    }
}
