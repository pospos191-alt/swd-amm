use std::fmt;

/// Every failure of the client.
#[derive(Debug)]
pub enum SwdError {
    /// network / TLS / timeout
    Http(reqwest::Error),
    /// the API answered with an error: its `code` (bad_chain, bad_address, bad_hash, read_failed, http_error, ...)
    Api { code: String, message: String, status: u16 },
    /// refused before any request
    BadInput(String),
    /// the answer was not what the API documents
    BadResponse(String),
}

impl SwdError {
    /// The API's error code, if the API answered.
    pub fn code(&self) -> Option<&str> {
        match self {
            SwdError::Api { code, .. } => Some(code),
            _ => None,
        }
    }
}

impl fmt::Display for SwdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SwdError::Http(e) => write!(f, "http: {e}"),
            SwdError::Api { code, message, status } => write!(f, "{message} ({code}, HTTP {status})"),
            SwdError::BadInput(m) => write!(f, "bad input: {m}"),
            SwdError::BadResponse(m) => write!(f, "bad response: {m}"),
        }
    }
}

impl std::error::Error for SwdError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SwdError::Http(e) => Some(e),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for SwdError {
    fn from(e: reqwest::Error) -> Self {
        SwdError::Http(e)
    }
}
