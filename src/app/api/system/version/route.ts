/**
 * This fork is updated by rebuilding its own image, not by installing upstream releases.
 * Keep the version endpoint for dashboard compatibility without checking npm or GitHub.
 */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { NEWS_JSON_URL, parseActiveNewsPayload } from "@/shared/utils/releaseNotes";

export const dynamic = "force-dynamic";

async function getNews() {
  try {
    const res = await fetch(NEWS_JSON_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = await res.json();
    return parseActiveNewsPayload(data);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = {
    current: APP_CONFIG.version,
    latest: APP_CONFIG.version,
    updateAvailable: false,
    channel: "manual",
    autoUpdateSupported: false,
    autoUpdateError: "Upstream updates are disabled for this fork. Rebuild its image to update.",
    news: await getNews(),
  };
  const serialized = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(serialized).digest("base64url")}"`;
  const headers = { "Cache-Control": "private, no-cache, must-revalidate", ETag: etag };
  const validators = req.headers
    .get("If-None-Match")
    ?.split(",")
    .map((value) => value.trim());
  if (validators?.some((value) => value === etag || value === `W/${etag}`)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(serialized, {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      success: false,
      error: "Upstream updates are disabled for this fork. Rebuild its image to update.",
    },
    { status: 403 }
  );
}
