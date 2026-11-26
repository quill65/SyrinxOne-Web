import { clearCachedAccessToken, getAccessToken } from './googleAuth';

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  isFolder: boolean;
  kind: 'folder' | 'audio' | 'annotation' | 'other';
  isDoc?: boolean;
  modifiedTime?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_EXT_RE = /\.(wav|flac|aif|aiff|ogg|mp3|m4a|opus)$/i;
const ANNOTATION_EXT_RE = /\.(txt|tsv|csv|json|log)$/i;
const DOC_EXT_RE = /\.(md|markdown|pdf|txt|rst|html?)$/i;
const DOC_BASENAME_RE = /^(readme|about|metadata|notes?|doc(s|umentation)?|citation|license|manifest)([._-].*)?$/i;

export function isDriveDocumentationFile(name: string, mimeType = ''): boolean {
  const clean = name.trim();
  const stem = clean.replace(/\.[a-z0-9]{1,8}$/i, '');
  if (DOC_BASENAME_RE.test(stem) || DOC_BASENAME_RE.test(clean)) {
    return !AUDIO_EXT_RE.test(clean);
  }
  if (/\.(md|markdown|pdf|rst)$/i.test(clean)) return true;
  return mimeType === 'application/pdf' || mimeType === 'text/markdown';
}

function classifyDriveItem(name: string, mimeType: string): DriveItem['kind'] {
  if (mimeType === FOLDER_MIME) return 'folder';
  if (mimeType.startsWith('audio/') || AUDIO_EXT_RE.test(name)) return 'audio';
  if (ANNOTATION_EXT_RE.test(name)) return 'annotation';
  return 'other';
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveAuthExpiredError extends Error {
  constructor(message = 'Google Drive session expired. Please sign in again.') {
    super(message);
    this.name = 'DriveAuthExpiredError';
  }
}

interface DriveFilesApiResponse {
  nextPageToken?: string;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
  }>;
  error?: {
    message?: string;
  };
}

export async function listDriveItems(
  location: 'root' | 'sharedWithMe' | string,
  searchQuery?: string,
): Promise<DriveItem[]> {
  const token = await getAccessToken();
  if (!token) {
    throw new DriveAuthExpiredError('Sign in with Google to browse your Google Drive.');
  }

  const clauses: string[] = ['trashed = false'];
  const trimmedSearch = searchQuery?.trim();

  if (trimmedSearch) {
    clauses.push(`name contains '${escapeDriveQueryLiteral(trimmedSearch)}'`);
    if (location !== 'root' && location !== 'sharedWithMe') {
      clauses.push(`'${escapeDriveQueryLiteral(location)}' in parents`);
    } else if (location === 'sharedWithMe') {
      clauses.push('sharedWithMe = true');
    }
  } else if (location === 'sharedWithMe') {
    clauses.push('sharedWithMe = true');
  } else {
    clauses.push(`'${escapeDriveQueryLiteral(location)}' in parents`);
  }

  const rawFiles: NonNullable<DriveFilesApiResponse['files']> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: clauses.join(' and '),
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
      orderBy: 'folder,name',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.status === 401) {
      clearCachedAccessToken();
      throw new DriveAuthExpiredError();
    }

    if (!res.ok) {
      let msg = `Google Drive request failed (${res.status})`;
      try {
        const errBody = (await res.json()) as DriveFilesApiResponse;
        if (errBody.error?.message) {
          msg = errBody.error.message;
        }
      } catch {
        // ignore parse failure
      }
      throw new Error(msg);
    }

    const data = (await res.json()) as DriveFilesApiResponse;
    if (data.files?.length) {
      rawFiles.push(...data.files);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return rawFiles
    .map((f) => {
      const kind = classifyDriveItem(f.name, f.mimeType);
      const isDoc =
        kind !== 'folder' &&
        kind !== 'audio' &&
        (isDriveDocumentationFile(f.name, f.mimeType) || DOC_EXT_RE.test(f.name));
      const parsedSize = f.size !== undefined ? Number(f.size) : undefined;
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: parsedSize !== undefined && Number.isFinite(parsedSize) ? parsedSize : undefined,
        isFolder: kind === 'folder',
        kind,
        isDoc,
        modifiedTime: f.modifiedTime,
      };
    })
    .filter((item) => item.kind !== 'other' || item.isDoc);
}

export async function readDriveTextFile(fileId: string, maxChars = 48000): Promise<string> {
  const token = await getAccessToken();
  if (!token) {
    throw new DriveAuthExpiredError('Sign in with Google to read Google Drive documentation.');
  }
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (res.status === 401) {
    clearCachedAccessToken();
    throw new DriveAuthExpiredError();
  }
  if (!res.ok) {
    throw new Error(`Failed to read Google Drive file (${res.status})`);
  }
  const text = await res.text();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n… (truncated)` : text;
}

export async function resolveDriveFolderId(folderId: string): Promise<string> {
  if (folderId !== 'root') return folderId;
  const token = await getAccessToken();
  if (!token) {
    throw new DriveAuthExpiredError('Sign in with Google to access your Google Drive.');
  }
  const res = await fetch('https://www.googleapis.com/drive/v3/files/root?fields=id', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    clearCachedAccessToken();
    throw new DriveAuthExpiredError();
  }
  if (!res.ok) {
    throw new Error(`Failed to resolve My Drive folder ID (${res.status})`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error('Google Drive did not return a folder ID for My Drive.');
  }
  return data.id;
}

