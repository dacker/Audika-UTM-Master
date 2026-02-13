
export interface UTMData {
  id: string;
  originalUrl: string;
  cleanUrl: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  [key: string]: string;
}

export type FileRow = Record<string, string>;

export interface AppState {
  data: FileRow[];
  headers: string[];
  isLoading: boolean;
  error: string | null;
  fileName: string | null;
}
