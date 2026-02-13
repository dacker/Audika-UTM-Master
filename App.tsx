
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { 
  Upload, 
  FileSpreadsheet, 
  Table as TableIcon, 
  Download, 
  ArrowRightLeft, 
  ChevronRight,
  Split,
  Merge,
  Info,
  Settings,
  Zap,
  Combine,
  Plus,
  Trash2,
  X,
  Link as LinkIcon,
  GripVertical,
  Undo2,
  Redo2,
  Edit2
} from 'lucide-react';
import { splitUrl, mergeUrl } from './utils/urlUtils';
import { FileRow, AppState } from './types';

type MergeMode = 'simple' | 'utm_params' | 'utm_url';

interface HistoryItem {
  data: FileRow[];
  headers: string[];
  columnWidths: Record<string, number>;
}

/**
 * Enhanced heuristic function to detect the best column for URL/UTM splitting.
 * Uses a weighted scoring system based on header names and value patterns.
 * Specifically prioritizes columns containing '&' as it indicates multi-parameter strings.
 */
const detectBestUrlColumn = (headers: string[], data: FileRow[]): string => {
  if (data.length === 0) return '';
  
  const sampleSize = Math.min(data.length, 25);
  const sample = data.slice(0, sampleSize);
  
  let bestCol = '';
  let highestScore = -1;

  headers.forEach(h => {
    let score = 0;
    const lowerH = h.toLowerCase();
    
    // 1. Header name scoring (Exact matches or strong partials)
    if (lowerH === 'url' || lowerH === 'original_url' || lowerH === 'link') score += 25;
    if (lowerH.includes('utm')) score += 20;
    if (lowerH.includes('landing_page')) score += 15;
    if (lowerH.includes('destination')) score += 12;
    if (lowerH.includes('campaign')) score += 10;
    if (lowerH.includes('source') || lowerH.includes('medium')) score += 8;
    if (lowerH === 'g' || lowerH === 'gclid' || lowerH === 'click_id') score += 5;

    // 2. Content pattern scoring
    let utmMatchCount = 0;
    let urlMatchCount = 0;
    let trackingIdMatchCount = 0;
    let queryStringMatchCount = 0;
    let ampersandMatchCount = 0;
    
    sample.forEach(row => {
      const val = String(row[h] || '').trim();
      if (!val) return;
      
      const lowerVal = val.toLowerCase();
      
      // Explicit UTM pattern (including utm_id as per guidelines)
      if (
        lowerVal.includes('utm_source=') || 
        lowerVal.includes('utm_medium=') || 
        lowerVal.includes('utm_campaign=') ||
        lowerVal.includes('utm_id=')
      ) {
        utmMatchCount++;
      }
      
      // Standard URL protocols or relative paths starting with /?
      if (/^https?:\/\//i.test(val) || /^www\./i.test(val) || val.startsWith('/?')) {
        urlMatchCount++;
      }

      // Other common tracking parameters (gclid, fbclid, msclkid)
      if (lowerVal.includes('gclid=') || lowerVal.includes('fbclid=') || lowerVal.includes('msclkid=')) {
        trackingIdMatchCount++;
      }

      // General query string structure
      if (val.includes('?') && val.includes('=')) {
        queryStringMatchCount++;
      }

      // Presence of '&' is a very strong signal for a UTM/Query string with multiple params
      if (val.includes('&') && val.includes('=')) {
        ampersandMatchCount++;
      }
    });

    // Weighted content scores
    score += (utmMatchCount / sampleSize) * 50; 
    score += (urlMatchCount / sampleSize) * 30;
    score += (trackingIdMatchCount / sampleSize) * 20;
    score += (queryStringMatchCount / sampleSize) * 10;
    score += (ampersandMatchCount / sampleSize) * 25; // Significant weight for '&' presence in query context

    if (score > highestScore) {
      highestScore = score;
      bestCol = h;
    }
  });

  // Threshold to avoid selecting completely irrelevant columns
  return highestScore > 5 ? bestCol : '';
};

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    data: [],
    headers: [],
    isLoading: false,
    error: null,
    fileName: null
  });
  
  // URL Toolkit State
  const [urlColumn, setUrlColumn] = useState<string>('');
  
  // Column Merge Toolkit State
  const [mergeMode, setMergeMode] = useState<MergeMode>('simple');
  const [mergeSourceColumns, setMergeSourceColumns] = useState<string[]>([]);
  const [mergeTargetColumn, setMergeTargetColumn] = useState<string>('');
  const [mergeSeparator, setMergeSeparator] = useState<string>(' ');
  const [isCustomSeparator, setIsCustomSeparator] = useState(false);
  const [customSeparator, setCustomSeparator] = useState<string>('');
  const [baseUrlColumn, setBaseUrlColumn] = useState<string>('');

  // Column Resizing State
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const resizingRef = useRef<{ header: string; startX: number; startWidth: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  // Column Reordering State
  const [draggedHeader, setDraggedHeader] = useState<string | null>(null);
  const [dragOverHeader, setDragOverHeader] = useState<string | null>(null);

  // Header Renaming State
  const [editingHeader, setEditingHeader] = useState<string | null>(null);
  const [editHeaderValue, setEditHeaderValue] = useState<string>('');

  // Undo/Redo History State
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Scroll Sync Refs
  const topScrollRef = useRef<HTMLDivElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingOnButton, setIsDraggingOnButton] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Push to history helper
  const pushToHistory = useCallback((data: FileRow[], headers: string[], widths: Record<string, number>) => {
    setHistory(prev => {
      const newHistory = prev.slice(0, historyIndex + 1);
      return [...newHistory, { data, headers, columnWidths: widths }];
    });
    setHistoryIndex(prev => prev + 1);
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      const { data, headers, columnWidths: widths } = history[prevIndex];
      setHistoryIndex(prevIndex);
      setState(s => ({ ...s, data, headers }));
      setColumnWidths(widths);
    }
  }, [historyIndex, history]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      const { data, headers, columnWidths: widths } = history[nextIndex];
      setHistoryIndex(nextIndex);
      setState(s => ({ ...s, data, headers }));
      setColumnWidths(widths);
    }
  }, [historyIndex, history]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  const calculateInitialWidths = (headers: string[], data: FileRow[]) => {
    const widths: Record<string, number> = {};
    headers.forEach(h => {
      const sampleRows = data.slice(0, 15);
      const maxChars = Math.max(
        h.length,
        ...sampleRows.map(row => (row[h]?.toString() || "").length)
      );
      widths[h] = Math.min(500, Math.max(120, maxChars * 9 + 48));
    });
    return widths;
  };

  // Memoize total table width for the top scrollbar
  const totalTableWidth = useMemo(() => {
    return state.headers.reduce((acc, h) => acc + (columnWidths[h] || 120), 0);
  }, [state.headers, columnWidths]);

  // Handle Scroll Syncing
  useEffect(() => {
    const top = topScrollRef.current;
    const bottom = tableContainerRef.current;
    if (!top || !bottom) return;

    let isSyncingTop = false;
    let isSyncingBottom = false;

    const handleTopScroll = () => {
      if (!isSyncingBottom) {
        isSyncingTop = true;
        bottom.scrollLeft = top.scrollLeft;
        isSyncingTop = false;
      }
    };

    const handleBottomScroll = () => {
      if (!isSyncingTop) {
        isSyncingBottom = true;
        top.scrollLeft = bottom.scrollLeft;
        isSyncingBottom = false;
      }
    };

    top.addEventListener('scroll', handleTopScroll);
    bottom.addEventListener('scroll', handleBottomScroll);

    return () => {
      top.removeEventListener('scroll', handleTopScroll);
      bottom.removeEventListener('scroll', handleBottomScroll);
    };
  }, [state.headers.length, totalTableWidth]);

  const processFile = (file: File) => {
    setState(prev => ({ ...prev, isLoading: true, error: null, fileName: file.name }));

    const reader = new FileReader();
    const extension = file.name.split('.').pop()?.toLowerCase();

    reader.onload = (evt) => {
      try {
        const result = evt.target?.result;
        if (!result) throw new Error("File reading failed");

        let jsonData: FileRow[] = [];
        let headers: string[] = [];

        if (extension === 'csv') {
          const parsed = Papa.parse(result as string, { header: true, skipEmptyLines: true });
          jsonData = parsed.data as FileRow[];
          headers = parsed.meta.fields || [];
        } else if (extension === 'xlsx' || extension === 'xls') {
          const workbook = XLSX.read(result, { type: 'binary' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          jsonData = XLSX.utils.sheet_to_json(worksheet) as FileRow[];
          if (jsonData.length > 0) {
            headers = Object.keys(jsonData[0]);
          }
        } else {
          throw new Error("Only .csv and .xlsx files are supported.");
        }

        const initialWidths = calculateInitialWidths(headers, jsonData);

        setState({
          data: jsonData,
          headers,
          isLoading: false,
          error: null,
          fileName: file.name
        });

        setColumnWidths(initialWidths);
        setHistory([{ data: jsonData, headers, columnWidths: initialWidths }]);
        setHistoryIndex(0);

        // Use the enhanced detection algorithm to select the best URL column
        const detectedCol = detectBestUrlColumn(headers, jsonData);
        if (detectedCol) {
          setUrlColumn(detectedCol);
        }

      } catch (err: any) {
        setState(prev => ({ ...prev, isLoading: false, error: err.message }));
      }
    };

    if (extension === 'csv') {
      reader.readAsText(file);
    } else {
      reader.readAsBinaryString(file);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.data.length > 0) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (state.data.length > 0) return;
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const deleteColumn = (headerToDelete: string) => {
    const newHeaders = state.headers.filter(h => h !== headerToDelete);
    const newData = state.data.map(row => {
      const { [headerToDelete]: _, ...rest } = row;
      return rest as FileRow;
    });

    const { [headerToDelete]: _, ...newWidths } = columnWidths;
    
    setState(prev => ({ ...prev, headers: newHeaders, data: newData }));
    setColumnWidths(newWidths);
    pushToHistory(newData, newHeaders, newWidths);

    if (urlColumn === headerToDelete) setUrlColumn('');
    if (baseUrlColumn === headerToDelete) setBaseUrlColumn('');
    if (mergeTargetColumn === headerToDelete) setMergeTargetColumn('');
    if (mergeSourceColumns.includes(headerToDelete)) {
      setMergeSourceColumns(prev => prev.filter(c => c !== headerToDelete));
    }
  };

  const renameColumn = (oldName: string, newName: string) => {
    if (!newName || newName.trim() === '' || oldName === newName) {
      setEditingHeader(null);
      return;
    }

    // Ensure no duplicates
    if (state.headers.includes(newName)) {
      setState(prev => ({ ...prev, error: `Column name "${newName}" already exists.` }));
      setTimeout(() => setState(prev => ({ ...prev, error: null })), 3000);
      setEditingHeader(null);
      return;
    }

    const newHeaders = state.headers.map(h => (h === oldName ? newName : h));
    const newData = state.data.map(row => {
      const { [oldName]: value, ...rest } = row;
      return { ...rest, [newName]: value };
    });

    const newWidths = { ...columnWidths };
    newWidths[newName] = newWidths[oldName];
    delete newWidths[oldName];

    setState(prev => ({ ...prev, headers: newHeaders, data: newData }));
    setColumnWidths(newWidths);
    pushToHistory(newData, newHeaders, newWidths);

    // Update references
    if (urlColumn === oldName) setUrlColumn(newName);
    if (baseUrlColumn === oldName) setBaseUrlColumn(newName);
    if (mergeTargetColumn === oldName) setMergeTargetColumn(newName);
    if (mergeSourceColumns.includes(oldName)) {
      setMergeSourceColumns(prev => prev.map(c => (c === oldName ? newName : c)));
    }

    setEditingHeader(null);
  };

  const processSplit = () => {
    if (!urlColumn || state.data.length === 0) return;
    const discoveredKeys = new Set<string>();
    const newData = state.data.map(row => {
      const url = row[urlColumn] || '';
      const { cleanUrl, params } = splitUrl(url);
      Object.keys(params).forEach(key => discoveredKeys.add(key));
      return { ...row, 'Clean URL': cleanUrl, ...params };
    });
    
    const newHeaders = [...state.headers];
    const addedHeaders: string[] = [];
    if (!newHeaders.includes('Clean URL')) {
      newHeaders.push('Clean URL');
      addedHeaders.push('Clean URL');
    }
    Array.from(discoveredKeys).forEach(key => {
      if (!newHeaders.includes(key)) {
        newHeaders.push(key);
        addedHeaders.push(key);
      }
    });

    const newWidths = { ...columnWidths, ...calculateInitialWidths(addedHeaders, newData) };
    setColumnWidths(newWidths);
    setState(prev => ({ ...prev, data: newData, headers: newHeaders }));
    pushToHistory(newData, newHeaders, newWidths);
  };

  const processColumnMerge = () => {
    if (mergeSourceColumns.length === 0 || !mergeTargetColumn || state.data.length === 0) return;
    const separator = isCustomSeparator ? customSeparator : mergeSeparator;
    const newData = state.data.map(row => {
      let result = '';
      if (mergeMode === 'simple') {
        const values = mergeSourceColumns.map(col => row[col]?.toString() || '').filter(v => v !== '');
        result = values.join(separator);
      } else if (mergeMode === 'utm_params' || mergeMode === 'utm_url') {
        const params = new URLSearchParams();
        mergeSourceColumns.forEach(col => {
          const val = row[col]?.toString() || '';
          if (val) params.set(col, val);
        });
        const queryString = params.toString();
        if (mergeMode === 'utm_params') {
          result = queryString;
        } else {
          const base = row[baseUrlColumn]?.toString() || '';
          if (!base) {
            result = queryString;
          } else {
            const connector = base.includes('?') ? '&' : '?';
            result = queryString ? `${base}${connector}${queryString}` : base;
          }
        }
      }
      return { ...row, [mergeTargetColumn]: result };
    });
    
    const newHeaders = [...state.headers];
    let newWidths = { ...columnWidths };
    if (!newHeaders.includes(mergeTargetColumn)) {
      newHeaders.push(mergeTargetColumn);
      const newWidth = calculateInitialWidths([mergeTargetColumn], newData);
      newWidths = { ...newWidths, ...newWidth };
      setColumnWidths(newWidths);
    }
    setState(prev => ({ ...prev, data: newData, headers: newHeaders }));
    pushToHistory(newData, newHeaders, newWidths);
  };

  const toggleMergeColumn = (col: string) => {
    setMergeSourceColumns(prev => prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]);
  };

  const downloadFile = () => {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; 
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, ''); 
    const timestamp = `${dateStr}_${timeStr}`;
    const ws = XLSX.utils.json_to_sheet(state.data, { header: state.headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Processed Data");
    const baseName = state.fileName ? state.fileName.replace(/\.[^/.]+$/, "") : 'data';
    XLSX.writeFile(wb, `${timestamp}_processed_${baseName}.xlsx`);
  };

  // Resizing logic - Optimized for high-speed response
  const onMouseDown = (header: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    if (th) {
      resizingRef.current = {
        header,
        startX: e.clientX,
        startWidth: th.offsetWidth,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('resizing-active');
    }
  };

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (resizingRef.current) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      
      rafRef.current = requestAnimationFrame(() => {
        if (!resizingRef.current) return;
        const { header, startX, startWidth } = resizingRef.current;
        const deltaX = e.clientX - startX;
        const newWidth = Math.max(80, startWidth + deltaX);
        setColumnWidths(prev => ({ ...prev, [header]: newWidth }));
      });
    }
  }, []);

  const onMouseUp = useCallback(() => {
    if (resizingRef.current) {
      resizingRef.current = null;
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      document.body.classList.remove('resizing-active');
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const handleColDragStart = (e: React.DragEvent, header: string) => {
    if (resizingRef.current || editingHeader) {
      e.preventDefault();
      return;
    }
    setDraggedHeader(header);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleColDragOver = (e: React.DragEvent, header: string) => {
    e.preventDefault();
    if (draggedHeader && draggedHeader !== header) setDragOverHeader(header);
  };

  const handleColDrop = (e: React.DragEvent, targetHeader: string) => {
    e.preventDefault();
    if (!draggedHeader || draggedHeader === targetHeader) {
      setDraggedHeader(null);
      setDragOverHeader(null);
      return;
    }
    const newHeaders = [...state.headers];
    const fromIndex = newHeaders.indexOf(draggedHeader);
    const toIndex = newHeaders.indexOf(targetHeader);
    newHeaders.splice(fromIndex, 1);
    newHeaders.splice(toIndex, 0, draggedHeader);
    setState(prev => ({ ...prev, headers: newHeaders }));
    pushToHistory(state.data, newHeaders, columnWidths);
    setDraggedHeader(null);
    setDragOverHeader(null);
  };

  const handleColDragEnd = () => {
    setDraggedHeader(null);
    setDragOverHeader(null);
  };

  return (
    <div 
      className={`min-h-screen flex flex-col transition-colors duration-200 ${isDragging ? 'bg-slate-100' : 'bg-slate-50'}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="fixed inset-0 z-[100] pointer-events-none border-4 border-dashed border-slate-400 m-4 rounded-2xl flex items-center justify-center bg-white/60 backdrop-blur-sm animate-in fade-in zoom-in duration-200">
           <div className="flex flex-col items-center gap-4">
              <div className="bg-slate-600 p-6 rounded-full shadow-xl shadow-slate-600/30">
                <Upload className="w-12 h-12 text-white animate-bounce" />
              </div>
              <h2 className="text-3xl font-bold text-slate-700">Drop your file anywhere</h2>
              <p className="text-slate-600 font-medium">CSV or XLSX files are supported</p>
           </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-slate-800 p-2 rounded-lg">
              <ArrowRightLeft className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 leading-none">Audika UTM Master</h1>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mt-1">Data Transformer</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {state.data.length > 0 && (
              <div className="flex items-center gap-2 pr-4 border-r border-slate-100">
                <button 
                  onClick={undo}
                  disabled={historyIndex <= 0}
                  className="p-2 text-sky-600 hover:bg-sky-50 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Undo (Ctrl+Z)"
                >
                  <Undo2 size={20} />
                </button>
                <button 
                  onClick={redo}
                  disabled={historyIndex >= history.length - 1}
                  className="p-2 text-sky-600 hover:bg-sky-50 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Redo (Ctrl+Shift+Z)"
                >
                  <Redo2 size={20} />
                </button>
              </div>
            )}

            {state.data.length > 0 && (
              <button 
                onClick={downloadFile}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors font-medium text-sm shadow-sm"
              >
                <Download size={18} />
                Download Result
              </button>
            )}
            <button 
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOnButton(true);
              }}
              onDragLeave={() => setIsDraggingOnButton(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOnButton(false);
                const file = e.dataTransfer.files?.[0];
                if (file) processFile(file);
              }}
              className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-all font-medium text-sm shadow-sm ${
                isDraggingOnButton 
                  ? 'bg-orange-700 ring-2 ring-orange-300 ring-offset-2 scale-105' 
                  : (isDragging ? 'bg-orange-700 scale-105' : 'bg-orange-500 hover:bg-orange-600')
              }`}
            >
              <Upload size={18} />
              {isDraggingOnButton ? 'Drop file here' : 'Upload File'}
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              className="hidden" 
              accept=".csv, .xlsx, .xls"
            />
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-6 flex flex-col gap-6">
        {state.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-center gap-3 animate-in slide-in-from-top duration-300">
            <Info className="w-5 h-5" />
            <p>{state.error}</p>
          </div>
        )}

        {state.data.length === 0 && !state.isLoading && (
          <div 
            className={`flex flex-col items-center justify-center py-20 bg-white border-2 border-dashed rounded-2xl transition-all duration-300 ${
              isDragging ? 'border-orange-500 bg-slate-50/30 ring-4 ring-slate-600/10' : 'border-slate-300'
            }`}
          >
            <div className={`transition-transform duration-300 ${isDragging ? 'scale-110 -translate-y-2' : ''}`}>
              <FileSpreadsheet className={`w-16 h-16 mb-4 transition-colors ${isDragging ? 'text-orange-500' : 'text-slate-300'}`} />
            </div>
            <h2 className={`text-xl font-semibold transition-colors ${isDragging ? 'text-orange-600' : 'text-slate-700'}`}>
              {isDragging ? 'Release to upload your data' : 'Welcome to Audika UTM Master'}
            </h2>
            <p className="text-slate-500 mt-2 max-w-md text-center">
              Professional campaign data toolkit. Split URLs, detect UTMs automatically, or merge columns into standard-compliant marketing URLs.
            </p>
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="mt-6 px-6 py-3 bg-white border border-slate-300 hover:border-orange-500 hover:text-orange-500 text-slate-700 rounded-xl transition-all font-semibold flex items-center gap-2 shadow-sm"
            >
              Choose a file from your computer
            </button>
          </div>
        )}

        {state.isLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-600"></div>
            <p className="mt-4 text-slate-500 font-medium">Processing file...</p>
          </div>
        )}

        {state.data.length > 0 && (
          <>
            {/* Top Toolbar Area: Configuration */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 shrink-0">
              {/* URL Toolkit Section - 1/3 Width */}
              <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex flex-col md:col-span-1">
                <h3 className="text-sm font-bold text-slate-800 mb-4 flex items-center gap-2 uppercase tracking-wider">
                  <Zap className="w-4 h-4 text-blue-500" />
                  Smart URL Toolkit
                </h3>
                <div className="space-y-4 flex-1">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Choose column to split:</label>
                    <select 
                      value={urlColumn}
                      onChange={(e) => setUrlColumn(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-medium"
                    >
                      <option value="">-- Select Column --</option>
                      {state.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  <div className="pt-2">
                    <button 
                      onClick={processSplit}
                      disabled={!urlColumn}
                      className="w-full flex items-center justify-center gap-2 bg-blue-50 hover:bg-blue-500 hover:text-white text-blue-600 px-4 py-2.5 rounded-lg border border-blue-100 transition-all font-bold text-xs disabled:opacity-50 group"
                    >
                      <Split size={14} /> 
                      Auto-Split All Params
                      <ChevronRight size={12} className="group-hover:translate-x-1 transition-transform ml-1" />
                    </button>
                  </div>
                </div>
              </section>

              {/* Column Merger Toolkit Section - 2/3 Width */}
              <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex flex-col md:col-span-2">
                <h3 className="text-sm font-bold text-slate-800 mb-4 flex items-center gap-2 uppercase tracking-wider">
                  <Combine className="w-4 h-4 text-blue-500" />
                  Column Merger
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Merge Mode</label>
                      <div className="grid grid-cols-3 gap-1">
                         <button 
                          onClick={() => setMergeMode('simple')}
                          className={`py-1.5 text-[9px] font-bold rounded border uppercase ${mergeMode === 'simple' ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-50 text-slate-500 border-slate-200'}`}
                         >Standard</button>
                         <button 
                          onClick={() => setMergeMode('utm_params')}
                          className={`py-1.5 text-[9px] font-bold rounded border uppercase ${mergeMode === 'utm_params' ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-50 text-slate-500 border-slate-200'}`}
                         >UTM String</button>
                         <button 
                          onClick={() => setMergeMode('utm_url')}
                          className={`py-1.5 text-[9px] font-bold rounded border uppercase ${mergeMode === 'utm_url' ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-50 text-slate-500 border-slate-200'}`}
                         >Full UTM URL</button>
                      </div>
                    </div>

                    {mergeMode === 'utm_url' && (
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                          <LinkIcon size={10} /> Base URL / Domain Column
                        </label>
                        <select 
                          value={baseUrlColumn}
                          onChange={(e) => setBaseUrlColumn(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400/20 focus:border-blue-500 font-medium"
                        >
                          <option value="">-- Select Column --</option>
                          {state.headers.map(h => (
                            <option key={h} value={h}>{h}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                        {mergeMode === 'simple' ? 'Source Columns' : 'UTM Parameter Columns'}
                      </label>
                      <div className="max-h-24 overflow-y-auto border border-slate-100 rounded-lg bg-slate-50 p-1 space-y-1 custom-scrollbar">
                        {state.headers.map(h => (
                          <button
                            key={h}
                            onClick={() => toggleMergeColumn(h)}
                            className={`w-full text-left px-2 py-1 rounded text-[11px] font-medium transition-colors flex items-center justify-between ${
                              mergeSourceColumns.includes(h) ? 'bg-blue-500 text-white' : 'hover:bg-slate-200 text-slate-600'
                            }`}
                          >
                            <span className="truncate">{h}</span>
                            {mergeSourceColumns.includes(h) && <Plus size={10} />}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 flex flex-col">
                    {mergeMode === 'simple' ? (
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Separator</label>
                        <div className="grid grid-cols-2 gap-1 mb-2">
                          {[{ label: 'Space', val: ' ' }, { label: 'Comma', val: ',' }, { label: 'Dash', val: '-' }, { label: 'Underscore', val: '_' }].map(sep => (
                            <button
                              key={sep.label}
                              onClick={() => { setIsCustomSeparator(false); setMergeSeparator(sep.val); }}
                              className={`py-1 text-[10px] font-bold rounded border transition-all ${!isCustomSeparator && mergeSeparator === sep.val ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300'}`}
                            >{sep.label}</button>
                          ))}
                        </div>
                        <button onClick={() => setIsCustomSeparator(!isCustomSeparator)} className={`w-full py-1 text-[10px] font-bold rounded border transition-all mb-2 ${isCustomSeparator ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                          {isCustomSeparator ? 'Disable Custom' : 'Custom Separator'}
                        </button>
                        {isCustomSeparator && (
                          <input type="text" value={customSeparator} onChange={(e) => setCustomSeparator(e.target.value)} placeholder="e.g. | or _" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 flex flex-col justify-center">
                        <p className="text-[11px] text-slate-500 italic px-2 py-4 border border-dashed border-slate-200 rounded-lg bg-slate-50/50">
                          {mergeMode === 'utm_params' ? 'Will create a standard URL encoded query string starting with key=value pairs.' : 'Will append encoded query parameters to your destination URLs automatically.'}
                        </p>
                      </div>
                    )}

                    <div className="mt-auto">
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Target Column Name</label>
                      <input type="text" value={mergeTargetColumn} onChange={(e) => setMergeTargetColumn(e.target.value)} placeholder="e.g. Full Campaign URL" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-medium" />
                    </div>
                  </div>
                </div>
                
                <div className="mt-4 pt-4 border-t border-slate-100">
                  <button 
                    onClick={processColumnMerge}
                    disabled={(mergeMode === 'utm_url' && !baseUrlColumn) || mergeSourceColumns.length === 0 || !mergeTargetColumn}
                    className="w-full flex items-center justify-center gap-2 bg-blue-50 hover:bg-blue-500 hover:text-white text-blue-600 px-4 py-2.5 rounded-lg border border-blue-100 transition-all font-bold text-xs disabled:opacity-50"
                  >
                    <Combine size={14} /> 
                    {mergeMode === 'simple' ? 'Merge Columns' : mergeMode === 'utm_params' ? 'Generate UTM String' : 'Generate Full UTM URL'}
                  </button>
                </div>
              </section>
            </div>

            {/* Bottom Section: Data Preview */}
            <div className="flex-1 min-h-[400px] overflow-hidden">
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-full relative">
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="p-1.5 bg-white border border-slate-200 rounded-lg">
                      <TableIcon className="w-4 h-4 text-slate-600" />
                    </div>
                    <h3 className="text-sm font-bold text-slate-800">Data Preview</h3>
                  </div>
                  <div className="flex items-center gap-2 text-slate-400 text-[10px] font-medium">
                    <Info size={12} className="text-slate-300" />
                    <span>Double-click header to rename. Drag to reorder.</span>
                    <div className="h-3 w-[1px] bg-slate-200 mx-1"></div>
                    <span className="truncate max-w-[150px]">{state.fileName}</span>
                    <div className="flex gap-1 shrink-0">
                      <span className="bg-slate-500 text-white text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded">{state.headers.length} Cols</span>
                      <span className="bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded">{state.data.length} Rows</span>
                    </div>
                  </div>
                </div>

                {/* Top Scrollbar Helper - Now Always Visible */}
                <div 
                  ref={topScrollRef}
                  className="overflow-x-auto overflow-y-hidden h-2.5 border-b border-slate-100 bg-slate-50/20 shrink-0 custom-scrollbar block"
                >
                  <div style={{ width: `${totalTableWidth}px`, height: '1px' }} />
                </div>

                <div ref={tableContainerRef} className="overflow-auto flex-1 custom-scrollbar">
                  <table className="w-full text-left text-xs border-collapse table-fixed">
                    <thead className="bg-slate-50 sticky top-0 z-[20]">
                      <tr>
                        {state.headers.map(header => (
                          <th 
                            key={header} 
                            draggable={!resizingRef.current && !editingHeader}
                            onDragStart={(e) => handleColDragStart(e, header)}
                            onDragOver={(e) => handleColDragOver(e, header)}
                            onDragEnd={handleColDragEnd}
                            onDrop={(e) => handleColDrop(e, header)}
                            style={{ 
                              width: columnWidths[header] ? `${columnWidths[header]}px` : 'auto',
                              opacity: draggedHeader === header ? 0.4 : 1,
                              backgroundColor: dragOverHeader === header ? '#e0f2fe' : undefined,
                              borderLeft: dragOverHeader === header ? '2px solid #38bdf8' : undefined
                            }}
                            className={`px-4 py-3 font-bold text-slate-500 border-b border-slate-200 whitespace-nowrap uppercase tracking-tighter group relative cursor-move transition-all duration-150 active:scale-[0.98] active:shadow-inner`}
                          >
                            <div className="flex items-center justify-between gap-2 overflow-hidden">
                              {editingHeader === header ? (
                                <input
                                  autoFocus
                                  className="flex-1 bg-white border border-blue-400 rounded px-1.5 py-0.5 text-slate-900 outline-none focus:ring-2 focus:ring-blue-200 shadow-sm"
                                  value={editHeaderValue}
                                  onChange={(e) => setEditHeaderValue(e.target.value)}
                                  onBlur={() => renameColumn(header, editHeaderValue)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') renameColumn(header, editHeaderValue);
                                    if (e.key === 'Escape') setEditingHeader(null);
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <span 
                                  className="truncate flex-1 cursor-text" 
                                  title={`Double-click to rename ${header}`}
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    setEditingHeader(header);
                                    setEditHeaderValue(header);
                                  }}
                                >
                                  {header}
                                </span>
                              )}
                              
                              <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                <button 
                                  onClick={(e) => { e.stopPropagation(); deleteColumn(header); }}
                                  className="p-1 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-all"
                                  title={`Delete ${header}`}
                                >
                                  <X size={12} strokeWidth={3} />
                                </button>
                              </div>
                            </div>
                            
                            {/* Resize Handle - OptimizedHitArea */}
                            {!editingHeader && (
                              <div 
                                onMouseDown={(e) => onMouseDown(header, e)}
                                className="absolute top-0 right-0 h-full w-3 -mr-1 cursor-col-resize hover:bg-sky-400/40 transition-colors z-[21] group-hover:opacity-100"
                              />
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {state.data.slice(0, 100).map((row, idx) => (
                        <tr key={idx} className="hover:bg-sky-50 transition-colors">
                          {state.headers.map(header => (
                            <td 
                              key={header} 
                              style={{ 
                                opacity: draggedHeader === header ? 0.6 : 1,
                                backgroundColor: dragOverHeader === header ? '#f8fafc' : undefined
                              }}
                              className="px-4 py-3 text-slate-600 truncate border-r border-slate-50/50 last:border-r-0" 
                              title={row[header]}
                            >
                              {row[header]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {state.data.length > 100 && (
                  <div className="p-3 text-center text-slate-400 italic text-[10px] border-t border-slate-100 bg-white shrink-0">Showing first 100 entries. Full results available in download.</div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 py-6 px-6 mt-auto shrink-0">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 text-slate-400 text-xs font-medium">
          <div className="flex items-center gap-2">
             <div className="bg-slate-100 p-1.5 rounded"><ArrowRightLeft size={16} /></div>
             <span>© 2024 Audika UTM Master - Professional Data Suite</span>
          </div>
          <div className="flex items-center gap-8">
            <span className="flex items-center gap-1.5 hover:text-slate-600 transition-colors cursor-default"><Zap size={14}/> Auto-Detection</span>
            <span className="flex items-center gap-1.5 hover:text-blue-600 transition-colors cursor-default"><Combine size={14}/> UTM Campaign Merger</span>
            <span className="flex items-center gap-1.5 hover:text-red-600 transition-colors cursor-default"><X size={14}/> Selective Deletion</span>
          </div>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        .animate-bounce { animation: bounce 1s infinite; }
        
        table {
          border-spacing: 0;
          table-layout: fixed; /* Ensures header widths control columns precisely */
        }
        thead th {
          position: sticky;
          top: 0;
          background: #f8fafc;
        }
        
        /* Drag styles */
        th[draggable="true"] {
          -webkit-user-drag: element;
          user-select: none;
        }
        
        .resizing-active, .resizing-active * {
          cursor: col-resize !important;
          user-select: none !important;
        }

        .dragging {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
};

export default App;
