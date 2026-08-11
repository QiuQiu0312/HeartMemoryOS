export class MemoryCoreError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class AuthorizationError extends MemoryCoreError {
  constructor(message = "A trusted authentication context is required.") {
    super(message, "AUTH_CONTEXT_REQUIRED");
  }
}

export class ValidationError extends MemoryCoreError {
  constructor(message, details = undefined) {
    super(message, "VALIDATION_ERROR", details);
  }
}

export class PrivacyDeniedError extends MemoryCoreError {
  constructor(receiptId, reason) {
    super("The privacy policy denied this write.", "PRIVACY_DENIED", { receiptId, reason });
  }
}

export class ConflictError extends MemoryCoreError {
  constructor(message, details = undefined) {
    super(message, "CONFLICT", details);
  }
}
