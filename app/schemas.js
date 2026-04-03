export function requireFields(payload, fields) {
  for (const field of fields) {
    if (
      payload[field] === undefined ||
      payload[field] === null ||
      payload[field] === ""
    ) {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
