import { createOrganizerBff } from "../../organizer-bff/src/organizerBff.js";
import { createAttendeeBff } from "../../attendee-bff/src/attendeeBff.js";

const DEFAULT_LIMIT_WINDOW_MS = 60_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function randomId() {
  return `trace_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

export function parseBearerToken(authorizationHeader) {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return null;
  }

  return authorizationHeader.slice("Bearer ".length).trim();
}

export class InMemoryRateLimiter {
  constructor({ windowMs = DEFAULT_LIMIT_WINDOW_MS, maxRequests = 120 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.buckets = new Map();
  }

  check(key, now = Date.now()) {
    const bucket = this.buckets.get(key) ?? { count: 0, resetAt: now + this.windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + this.windowMs;
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);

    const allowed = bucket.count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(this.maxRequests - bucket.count, 0),
      resetAt: bucket.resetAt
    };
  }
}

function normalizePath(path) {
  const noQuery = path.split("?")[0];
  return noQuery.endsWith("/") && noQuery.length > 1 ? noQuery.slice(0, -1) : noQuery;
}

function resolveRole(request) {
  return (request.headers?.["x-user-role"] ?? "attendee").toLowerCase();
}

function versionFromPath(path) {
  const match = normalizePath(path).match(/^\/api\/(v\d+)/i);
  return match ? match[1].toLowerCase() : null;
}

export function createApiGateway({
  organizerBff = createOrganizerBff(),
  attendeeBff = createAttendeeBff(),
  rateLimiter = new InMemoryRateLimiter(),
  supportedVersions = ["v1"]
} = {}) {
  function forwardToBff({ bff, request, traceId, token, path }) {
    const forwardedHeaders = {
      ...(request.headers ?? {}),
      "x-trace-id": traceId,
      authorization: token ? `Bearer ${token}` : undefined
    };

    return bff.handle({
      ...request,
      path,
      headers: forwardedHeaders,
      meta: {
        traceId,
        token,
        role: resolveRole(request)
      }
    });
  }

  return {
    handle(request) {
      const traceId = request.headers?.["x-trace-id"] ?? randomId();
      const path = normalizePath(request.path ?? "/");
      const version = versionFromPath(path);

      if (!version || !supportedVersions.includes(version)) {
        return {
          status: 404,
          traceId,
          error: {
            code: "unsupported_version",
            message: "Requested API version is not supported"
          }
        };
      }

      const rateLimitKey = request.ip ?? request.headers?.["x-forwarded-for"] ?? "anonymous";
      const limit = rateLimiter.check(rateLimitKey);

      if (!limit.allowed) {
        return {
          status: 429,
          traceId,
          error: {
            code: "rate_limited",
            message: "Too many requests"
          },
          rateLimit: {
            remaining: limit.remaining,
            resetAt: limit.resetAt
          }
        };
      }

      const role = resolveRole(request);
      const token = parseBearerToken(request.headers?.authorization);
      const bffPath = path.replace(`/api/${version}`, "") || "/";

      if (bffPath.startsWith("/organizer")) {
        if (role !== "admin" && role !== "organizer") {
          return {
            status: 403,
            traceId,
            error: {
              code: "forbidden",
              message: "Organizer routes require admin privileges"
            }
          };
        }

        return clone(
          forwardToBff({
            bff: organizerBff,
            request,
            traceId,
            token,
            path: bffPath.replace("/organizer", "") || "/"
          })
        );
      }

      if (bffPath.startsWith("/attendee")) {
        return clone(
          forwardToBff({
            bff: attendeeBff,
            request,
            traceId,
            token,
            path: bffPath.replace("/attendee", "") || "/"
          })
        );
      }

      return {
        status: 404,
        traceId,
        error: {
          code: "route_not_found",
          message: "No route found for request"
        }
      };
    }
  };
}
