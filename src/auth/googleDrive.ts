import { clearCachedAccessToken, getAccessToken } from './googleAuth';

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  isFolder: boolean;
  kind: 'folder' | 'audio' | 'annotation' | 'other';
  modifiedTime?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_EXT_RE = /\.(wav|flac|aif|aiff|ogg|mp3|m4a|opus)$/i;
const ANNOTATION_EXT_RE = /\.(txt|tsv|csv|json|log)$/i;

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

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    orderBy: 'folder,name',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

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
  const rawFiles = data.files ?? [];

  return rawFiles
    .map((f) => {
      const kind = classifyDriveItem(f.name, f.mimeType);
      const parsedSize = f.size !== undefined ? Number(f.size) : undefined;
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: parsedSize !== undefined && Number.isFinite(parsedSize) ? parsedSize : undefined,
        isFolder: kind === 'folder',
        kind,
        modifiedTime: f.modifiedTime,
      };
    })
    .filter((item) => item.kind !== 'other');
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

