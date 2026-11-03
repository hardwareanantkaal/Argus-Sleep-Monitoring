// Error shape for every API error (docs/API.md §0):
//   { "error": { "code": "INVALID_CODE", "message": "...", "field": "claimCode" } }
class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const E = {
  bad: (code, message, field) => new ApiError(400, code, message, field),
  unauth: (code = 'UNAUTHENTICATED', message = 'Please log in') => new ApiError(401, code, message),
  forbidden: (code = 'FORBIDDEN', message = 'Not allowed') => new ApiError(403, code, message),
  notFound: (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message),
  conflict: (code, message, field) => new ApiError(409, code, message, field),
  invalid: (code, message, field) => new ApiError(422, code, message, field),
  tooMany: (message = 'Too many attempts, try again later') => new ApiError(429, 'RATE_LIMITED', message),
  notEnabled: (message = 'Not enabled in this version') => new ApiError(501, 'NOT_ENABLED', message),
};

module.exports = { ApiError, E };
