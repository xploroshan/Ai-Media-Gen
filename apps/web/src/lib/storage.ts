import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

/** storageKey format everywhere: `<bucket>/<key...>` (mirrors worker/lib/s3.py). */

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

export const BUCKETS = {
  originals: env.S3_BUCKET_ORIGINALS,
  derived: env.S3_BUCKET_DERIVED,
  renders: env.S3_BUCKET_RENDERS,
  generated: env.S3_BUCKET_GENERATED,
} as const;

export function splitStorageKey(storageKey: string): { bucket: string; key: string } {
  const slash = storageKey.indexOf("/");
  if (slash <= 0 || slash === storageKey.length - 1) {
    throw new Error(`bad storageKey: ${storageKey}`);
  }
  return { bucket: storageKey.slice(0, slash), key: storageKey.slice(slash + 1) };
}

export const MULTIPART_THRESHOLD = 64 * 1024 * 1024; // SPEC §3: multipart ≥64 MB
export const PART_SIZE = 32 * 1024 * 1024;

export async function presignPut(storageKey: string, contentType?: string): Promise<string> {
  const { bucket, key } = splitStorageKey(storageKey);
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 3600 },
  );
}

export async function presignGet(storageKey: string, expiresIn = 3600): Promise<string> {
  const { bucket, key } = splitStorageKey(storageKey);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export async function startMultipart(
  storageKey: string,
  bytes: number,
  contentType?: string,
): Promise<{ uploadId: string; partSize: number; partUrls: string[] }> {
  const { bucket, key } = splitStorageKey(storageKey);
  const created = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  );
  const uploadId = created.UploadId!;
  const partCount = Math.ceil(bytes / PART_SIZE);
  const partUrls = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: i + 1 }),
        { expiresIn: 3600 },
      ),
    ),
  );
  return { uploadId, partSize: PART_SIZE, partUrls };
}

export async function completeMultipart(
  storageKey: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
): Promise<void> {
  const { bucket, key } = splitStorageKey(storageKey);
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
}

export async function abortMultipart(storageKey: string, uploadId: string): Promise<void> {
  const { bucket, key } = splitStorageKey(storageKey);
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

export async function objectExists(storageKey: string): Promise<boolean> {
  const { bucket, key } = splitStorageKey(storageKey);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}
