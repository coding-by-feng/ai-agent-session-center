// resourceUri.ts — a URI as a resource and its variables: which of the resources a central is offered a URI names,
// with its variables decoded, and those variables as the backing tool's arguments, checked against the tool's own
// input shape. Reads (resources.ts) and subscriptions (resourceSubscriptions.ts) both go through here, so a URI
// means the same to a subscription as to a read.

import { UriTemplate, type Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { RESOURCE_DEFS, type OfferedResource, type ResourceVars } from './resourceDefs.js';
import { ToolError } from './types.js';

/** Longer than any URI the table can make: ids are at most 200 characters, each at most three bytes of escapes. */
const URI_MAX = 2_048;

const TEMPLATES: ReadonlyMap<string, UriTemplate> = new Map(
  RESOURCE_DEFS.map((def) => [def.uri, new UriTemplate(def.uri)]),
);

const notFound = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'This central has no resource at that URI.',
    'Call resources/templates/list to see the resources it has.',
  );

/** The variables a template matched, percent-decoded: `UriTemplate` hands them back as the URI spelled them. */
function decoded(matched: Variables): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(matched)) {
    const text = Array.isArray(value) ? (value[0] ?? '') : value;
    try {
      vars[name] = decodeURIComponent(text);
    } catch {
      throw new ToolError(
        'INVALID',
        'The resource URI has a malformed %-escape.',
        'Write a character as %XX hex digits, for example %2F for a slash.',
      );
    }
  }
  return vars;
}

/**
 * Which of `offered` a URI names, and its variables decoded. NOT_FOUND for text that is no URI, or names no resource
 * of the central's (the message never repeats it); INVALID for a malformed %-escape. The match is the one the SDK's
 * own `resources/read` routing makes, on the URL's normalized spelling, so a subscription means what a read means.
 */
export function parseResourceUri(
  offered: readonly OfferedResource[],
  uri: string,
): { offered: OfferedResource; vars: Record<string, string> } {
  if (uri.length > URI_MAX) throw notFound();
  let normal: string;
  try {
    normal = new URL(uri).toString();
  } catch {
    throw notFound();
  }
  for (const candidate of offered) {
    const matched = TEMPLATES.get(candidate.def.uri)?.match(normal) ?? null;
    if (matched !== null) return { offered: candidate, vars: decoded(matched) };
  }
  throw notFound();
}

/**
 * The tool's arguments for a URI's variables, checked against the tool's own input shape (defaults filled in).
 * INVALID, naming the fields and the rule they broke, never the value.
 */
export async function checkedArgs(
  offered: OfferedResource,
  vars: ResourceVars,
): Promise<Record<string, unknown>> {
  const raw = offered.def.args(vars);
  if (offered.check === null) return raw;
  const parsed = await offered.check.safeParseAsync(raw);
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const fields = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(uri)'}: ${issue.message}`)
    .join('; ');
  throw new ToolError(
    'INVALID',
    `Invalid resource URI for ${offered.def.uri}: ${fields}`,
    `Write it as ${offered.def.uri}.`,
  );
}
