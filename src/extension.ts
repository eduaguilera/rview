import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import the Positron API if available
let positron: any;
try {
    positron = require('positron');
} catch (e) {
    positron = null;
}

/**
 * Positron Tibble Explorer Extension
 * 
 * This extension provides ctrl+click functionality on R tibble/data.frame names
 * to open them directly in Positron's Data Explorer.
 */

// Patterns that suggest a variable is a tibble/data.frame
const TIBBLE_CREATION_PATTERNS = [
    'tibble', 'tribble', 'data.frame', 'data_frame',
    'read_csv', 'read_tsv', 'read_delim', 'read_excel',
    'read.csv', 'read.table', 'read.delim',
    'as_tibble', 'as.data.frame',
    'mutate', 'select', 'filter', 'arrange', 'summarize', 'summarise',
    'group_by', 'ungroup', 'slice', 'distinct',
    'left_join', 'right_join', 'inner_join', 'full_join', 'anti_join', 'semi_join',
    'bind_rows', 'bind_cols',
    'pivot_longer', 'pivot_wider', 'spread', 'gather',
    'fread', 'setDT', 'as.data.table',
];

/**
 * Open a variable in Positron's Data Explorer by executing View()
 */
async function openInDataExplorer(variableName: string): Promise<void> {
    const code = `View(${variableName})`;
    
    // Method 1: Try using the Positron API directly (positron.runtime.executeCode)
    if (positron && positron.runtime && positron.runtime.executeCode) {
        try {
            await positron.runtime.executeCode(
                'r',      // language
                code,     // code to execute
                true,     // focus the console
                false     // allowIncomplete
            );
            vscode.window.showInformationMessage(`Opening "${variableName}" in Data Explorer`);
            return;
        } catch (e) {
            console.log('positron.runtime.executeCode failed:', e);
        }
    }

    // Method 2: Try the console execute command
    try {
        await vscode.commands.executeCommand('workbench.action.positronConsole.executeCode', {
            code: code,
            languageId: 'r',
            focus: true
        });
        vscode.window.showInformationMessage(`Opening "${variableName}" in Data Explorer`);
        return;
    } catch (e) {
        console.log('workbench.action.positronConsole.executeCode failed:', e);
    }

    // Method 3: Try internal console command
    try {
        await vscode.commands.executeCommand('_executeCodeInConsole', 'r', vscode.Uri.file(''), { lineNumber: 1, column: 1 });
    } catch (e) {
        console.log('_executeCodeInConsole failed:', e);
    }

    // Method 4: Fallback - copy to clipboard
    await vscode.env.clipboard.writeText(code);
    vscode.window.showWarningMessage(
        `Copied "View(${variableName})" to clipboard. Paste in R console to view.`
    );
}

/**
 * Check if a variable might be a tibble/data.frame based on how it's defined
 */
function mightBeTibble(document: vscode.TextDocument, varName: string): boolean {
    const text = document.getText();
    
    // Check if variable is assigned with tibble creation patterns
    for (const pattern of TIBBLE_CREATION_PATTERNS) {
        const regex = new RegExp(`${varName}\\s*(<-|=).*${pattern}`, 'i');
        if (regex.test(text)) {
            return true;
        }
    }

    // Check for pipe assignments (likely data transformation)
    const pipeRegex = new RegExp(`${varName}\\s*<-.*(%>%|\\|>)`, 's');
    if (pipeRegex.test(text)) {
        return true;
    }

    return false;
}

/**
 * Simple Data Viewer with Column Filters (RStudio-style)
 * 
 * A lightweight data viewer that displays data in a table with
 * filter inputs at the top of each column.
 */
class SimpleDataViewerPanel {
    public static currentPanel: SimpleDataViewerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _variableName: string;
    private static _tempDir: string = path.join(os.tmpdir(), 'rview');

    public static async createOrShow(extensionUri: vscode.Uri, variableName: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // Ensure temp directory exists
        if (!fs.existsSync(SimpleDataViewerPanel._tempDir)) {
            fs.mkdirSync(SimpleDataViewerPanel._tempDir, { recursive: true });
        }

        // If we already have a panel, show it and update
        if (SimpleDataViewerPanel.currentPanel) {
            SimpleDataViewerPanel.currentPanel._panel.reveal(column);
            await SimpleDataViewerPanel.currentPanel._loadData(variableName);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'simpleDataViewer',
            `Data: ${variableName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        SimpleDataViewerPanel.currentPanel = new SimpleDataViewerPanel(panel, extensionUri, variableName);
        await SimpleDataViewerPanel.currentPanel._loadData(variableName);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, variableName: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._variableName = variableName;

        // Set initial loading content
        this._panel.webview.html = this._getLoadingHtml(variableName);

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this._loadData(this._variableName);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        SimpleDataViewerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _loadData(variableName: string) {
        this._variableName = variableName;
        this._panel.title = `Data: ${variableName}`;
        this._panel.webview.html = this._getLoadingHtml(variableName);

        // Create temp file path for JSON output
        const tempFile = path.join(SimpleDataViewerPanel._tempDir, `data_${Date.now()}.csv`);
        const tempFileEscaped = tempFile.replace(/\\/g, '/');

        // R code to write data to temp file using FAST CSV export
        const rCode = `
tryCatch({
    # Use data.table for blazing fast export (install if needed)
    if (!requireNamespace("data.table", quietly = TRUE)) {
        install.packages("data.table", repos = "https://cloud.r-project.org")
    }
    
    .tmp_data <- as.data.frame(${variableName})
    .tmp_nrow <- nrow(.tmp_data)
    .tmp_ncol <- ncol(.tmp_data)
    .tmp_cols <- colnames(.tmp_data)
    
    # Convert all columns to character for consistent display
    .tmp_data[] <- lapply(.tmp_data, as.character)
    
    # Write metadata as first line, then CSV data (data.table::fwrite is ~100x faster than lapply)
    .tmp_meta <- paste0("__META__,", .tmp_nrow, ",", .tmp_ncol)
    writeLines(.tmp_meta, "${tempFileEscaped}")
    data.table::fwrite(.tmp_data, "${tempFileEscaped}", append = TRUE, quote = TRUE)
    
    rm(.tmp_data, .tmp_nrow, .tmp_ncol, .tmp_cols, .tmp_meta)
    message("Data exported successfully")
}, error = function(e) {
    writeLines(paste0('__ERROR__,', gsub(',', ';', e$message)), "${tempFileEscaped}")
})
`;

        // Execute the R code
        let executed = false;

        // Method 1: Try using the Positron API directly
        if (positron && positron.runtime && positron.runtime.executeCode) {
            try {
                await positron.runtime.executeCode('r', rCode, false, false);
                executed = true;
            } catch (e) {
                console.log('positron.runtime.executeCode failed:', e);
            }
        }

        // Method 2: Try the console execute command
        if (!executed) {
            try {
                await vscode.commands.executeCommand('workbench.action.positronConsole.executeCode', {
                    code: rCode,
                    languageId: 'r',
                    focus: false
                });
                executed = true;
            } catch (e) {
                console.log('workbench.action.positronConsole.executeCode failed:', e);
            }
        }

        if (!executed) {
            // Fallback: show manual instructions
            this._panel.webview.html = this._getManualHtml(variableName);
            return;
        }

        // Wait for CSV file to be created (poll for up to 60 seconds for large datasets)
        let data: any = null;
        const maxWait = 60000;
        const pollInterval = 200;
        let waited = 0;

        while (waited < maxWait) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            waited += pollInterval;

            if (fs.existsSync(tempFile)) {
                try {
                    const content = fs.readFileSync(tempFile, 'utf-8');
                    const lines = content.split('\n');
                    
                    // Check for error
                    if (lines[0].startsWith('__ERROR__')) {
                        const errorMsg = lines[0].split(',').slice(1).join(',');
                        data = { error: errorMsg };
                    } else if (lines[0].startsWith('__META__')) {
                        // Parse metadata: __META__,nrow,ncol
                        const metaParts = lines[0].split(',');
                        const nrow = parseInt(metaParts[1]);
                        const ncol = parseInt(metaParts[2]);
                        
                        // Parse CSV header (column names) - line 1
                        const columns = this._parseCSVLine(lines[1]);
                        
                        // Parse CSV data rows - lines 2+
                        const rows: string[][] = [];
                        for (let i = 2; i < lines.length; i++) {
                            if (lines[i].trim()) {
                                rows.push(this._parseCSVLine(lines[i]));
                            }
                        }
                        
                        data = { columns, rows, nrow, ncol, loadedRows: rows.length };
                    }
                    
                    fs.unlinkSync(tempFile); // Clean up
                    break;
                } catch (e) {
                    console.log('Error reading temp file:', e);
                }
            }
        }

        if (data && data.error) {
            this._panel.webview.html = this._getErrorHtml(variableName, data.error);
        } else if (data && data.columns) {
            this._panel.webview.html = this._getDataHtml(variableName, data);
        } else {
            // Timeout or failed
            this._panel.webview.html = this._getManualHtml(variableName);
        }
    }

    // Simple CSV line parser that handles quoted fields
    private _parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];
            
            if (inQuotes) {
                if (char === '"' && nextChar === '"') {
                    current += '"';
                    i++; // Skip next quote
                } else if (char === '"') {
                    inQuotes = false;
                } else {
                    current += char;
                }
            } else {
                if (char === '"') {
                    inQuotes = true;
                } else if (char === ',') {
                    result.push(current);
                    current = '';
                } else {
                    current += char;
                }
            }
        }
        result.push(current);
        return result;
    }

    private _getLoadingHtml(variableName: string): string {
        return `<!DOCTYPE html>
<html><head><style>
body { 
    font-family: var(--vscode-font-family); 
    padding: 40px; 
    text-align: center; 
    color: var(--vscode-foreground); 
    background: var(--vscode-editor-background); 
}
.spinner { 
    border: 4px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); 
    border-top: 4px solid var(--vscode-button-background); 
    border-radius: 50%; 
    width: 40px; 
    height: 40px; 
    animation: spin 1s linear infinite; 
    margin: 20px auto; 
}
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
p { color: var(--vscode-descriptionForeground); }
</style></head><body>
<div class="spinner"></div>
<h2>Loading ${variableName}...</h2>
<p>Fetching data from R session</p>
</body></html>`;
    }

    private _getErrorHtml(variableName: string, error: string): string {
        return `<!DOCTYPE html>
<html><head><style>
body { 
    font-family: var(--vscode-font-family); 
    padding: 40px; 
    color: var(--vscode-foreground); 
    background: var(--vscode-editor-background); 
}
.error { 
    background: var(--vscode-inputValidation-errorBackground); 
    border: 1px solid var(--vscode-inputValidation-errorBorder); 
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    padding: 15px; 
    border-radius: 4px; 
}
button { 
    background: var(--vscode-button-background); 
    color: var(--vscode-button-foreground); 
    border: none; 
    padding: 8px 16px; 
    cursor: pointer; 
    border-radius: 2px; 
    margin-top: 15px; 
}
button:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
<h2>❌ Error loading ${variableName}</h2>
<div class="error">${this._escapeHtml(error)}</div>
<button onclick="location.reload()">Try Again</button>
</body></html>`;
    }

    private _getManualHtml(variableName: string): string {
        const rCode = `.view_data <- function(df) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite")
  json <- jsonlite::toJSON(list(
    columns = colnames(df),
    rows = lapply(1:nrow(df), function(i) as.character(unlist(df[i, ]))),
    nrow = nrow(df), ncol = ncol(df)
  ), auto_unbox = TRUE)
  if (Sys.info()["sysname"] == "Windows") writeClipboard(as.character(json))
  else if (Sys.info()["sysname"] == "Darwin") { p <- pipe("pbcopy", "w"); writeLines(json, p); close(p) }
  message("Data copied! Click Paste in viewer.")
}
.view_data(${variableName})`;

        return `<!DOCTYPE html>
<html><head><style>
body { 
    font-family: var(--vscode-font-family); 
    padding: 20px; 
    color: var(--vscode-foreground); 
    background: var(--vscode-editor-background); 
}
.instructions { 
    background: var(--vscode-textBlockQuote-background); 
    border-left: 3px solid var(--vscode-textLink-foreground); 
    padding: 15px; 
    margin: 15px 0;
    border-radius: 0 4px 4px 0;
}
pre { 
    background: var(--vscode-textCodeBlock-background); 
    color: var(--vscode-foreground);
    padding: 10px; 
    border-radius: 4px; 
    overflow-x: auto; 
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
button { 
    background: var(--vscode-button-background); 
    color: var(--vscode-button-foreground); 
    border: none; 
    padding: 8px 16px; 
    cursor: pointer; 
    border-radius: 2px; 
    margin: 5px; 
}
button:hover { background: var(--vscode-button-hoverBackground); }
#tableContainer { margin-top: 20px; }
table { 
    border-collapse: collapse; 
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
}
table th, table td {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    padding: 6px 10px;
}
table th {
    background: var(--vscode-editorWidget-background);
}
</style></head><body>
<h2>📊 ${variableName}</h2>
<p>⚠️ Could not automatically load data. Please use manual method:</p>
<div class="instructions">
<ol>
<li>Copy the R code below and run it in your R console</li>
<li>Click "Paste Data" to load the table</li>
</ol>
</div>
<pre id="rCode">${this._escapeHtml(rCode)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('rCode').textContent)">📋 Copy R Code</button>
<button id="pasteBtn">📥 Paste Data</button>
<div id="tableContainer"></div>
<script>
document.getElementById('pasteBtn').addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        const data = JSON.parse(text);
        if (data.columns && data.rows) {
            renderTable(data);
        }
    } catch(e) { alert('Failed to parse data: ' + e.message); }
});
function renderTable(data) {
    let html = '<p>' + data.nrow + ' rows × ' + data.ncol + ' cols</p><table><tr><th>#</th>';
    data.columns.forEach(c => html += '<th>' + c + '</th>');
    html += '</tr>';
    data.rows.forEach((row, i) => {
        html += '<tr><td>' + (i+1) + '</td>';
        row.forEach(cell => html += '<td>' + (cell || '') + '</td>');
        html += '</tr>';
    });
    html += '</table>';
    document.getElementById('tableContainer').innerHTML = html;
}
</script>
</body></html>`;
    }

    private _getDataHtml(variableName: string, data: { columns: string[], rows: string[][], nrow: number, ncol: number }): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Data: ${variableName}</title>
    <style>
        :root {
            --border-color: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
            --header-bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            --row-hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
            --row-number-bg: var(--vscode-editorLineNumber-foreground, rgba(128, 128, 128, 0.2));
        }
        * { box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0; padding: 10px;
        }
        .header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 10px; padding-bottom: 10px;
            border-bottom: 1px solid var(--border-color);
        }
        .header h2 { margin: 0; font-size: 1.2em; }
        .info { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
        .toolbar { margin-bottom: 10px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; padding: 6px 14px; cursor: pointer; border-radius: 2px;
        }
        button:hover { background-color: var(--vscode-button-hoverBackground); }
        .sort-info {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-left: 10px;
        }
        .table-container {
            overflow: auto; max-height: calc(100vh - 140px);
            border: 1px solid var(--border-color); border-radius: 4px;
            background-color: var(--vscode-editor-background);
        }
        table { border-collapse: collapse; width: max-content; min-width: 100%; table-layout: fixed; }
        th, td {
            border: 1px solid var(--border-color);
            padding: 6px 10px; text-align: left; white-space: nowrap;
            overflow: hidden; text-overflow: ellipsis;
            background-color: var(--vscode-editor-background);
        }
        th {
            background-color: var(--header-bg);
            position: sticky; top: 0; z-index: 10;
            position: relative;
            border-bottom: 1px solid var(--border-color);
        }
        .filter-row th { 
            top: 0; z-index: 12; padding: 4px; 
            background-color: var(--header-bg);
        }
        .header-row th { 
            top: 33px; font-weight: bold; cursor: pointer; 
            user-select: none; position: sticky; z-index: 11;
            background-color: var(--header-bg);
        }
        .header-row th:hover { background-color: var(--row-hover); }
        .sort-indicator { margin-left: 5px; font-size: 0.8em; }
        .sort-order { font-size: 0.7em; color: var(--vscode-descriptionForeground); vertical-align: super; }
        .filter-input {
            width: 100%; min-width: 60px; padding: 4px 6px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px; font-size: 12px;
        }
        .filter-input::placeholder { color: var(--vscode-input-placeholderForeground); }
        .filter-input:focus { 
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .row-number {
            color: var(--vscode-editorLineNumber-foreground);
            text-align: right; font-size: 0.85em;
            background-color: var(--header-bg) !important;
            width: 50px; min-width: 50px;
        }
        tbody tr:hover td { background-color: var(--row-hover); }
        tbody tr:hover td.row-number { background-color: var(--header-bg) !important; }
        .status-bar { margin-top: 10px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
        /* Resizable columns */
        .resize-handle {
            position: absolute;
            right: 0;
            top: 0;
            bottom: 0;
            width: 5px;
            cursor: col-resize;
            background: transparent;
        }
        .resize-handle:hover, .resize-handle.resizing {
            background: var(--vscode-focusBorder, #007acc);
        }
        .resizable { position: relative; }
    </style>
</head>
<body>
    <div class="header">
        <h2>📊 ${variableName}</h2>
        <span class="info">${data.nrow} rows × ${data.ncol} columns</span>
    </div>
    <div class="toolbar">
        <button id="clearFiltersBtn">🔄 Clear Filters</button>
        <button id="clearSortBtn">↕️ Clear Sort</button>
        <button id="refreshBtn">🔃 Refresh</button>
        <span class="sort-info" id="sortInfo"></span>
    </div>
    <div class="table-container">
        <table id="dataTable">
            <thead>
                <tr class="filter-row">
                    <th class="row-number"></th>
                    ${data.columns.map((_, i) => `<th class="resizable" style="min-width:80px;"><input type="text" class="filter-input" data-col="${i}" placeholder="Filter..."><div class="resize-handle" data-col="${i}"></div></th>`).join('')}
                </tr>
                <tr class="header-row">
                    <th class="row-number">#</th>
                    ${data.columns.map((col, i) => `<th class="sortable resizable" data-col="${i}" style="min-width:80px;">${this._escapeHtml(col)}<span class="sort-indicator"></span><div class="resize-handle" data-col="${i}"></div></th>`).join('')}
                </tr>
            </thead>
            <tbody id="tableBody">
            </tbody>
        </table>
    </div>
    <div class="status-bar" id="statusBar">${data.nrow.toLocaleString()} rows × ${data.ncol} columns</div>

    <script>
        const originalRows = ${JSON.stringify(data.rows)};
        const columns = ${JSON.stringify(data.columns)};
        let displayRows = originalRows.map((row, i) => ({ data: row, originalIndex: i }));
        
        // Virtual scrolling configuration
        const ROWS_PER_BATCH = 100; // Render 100 rows at a time
        let visibleStartIndex = 0;
        let visibleEndIndex = ROWS_PER_BATCH;
        
        // Debounce timer for filter inputs
        let filterDebounceTimer = null;
        let sortStack = []; // Array of { col, dir } for multi-level sorting
        const vscode = acquireVsCodeApi();

        // Initial render
        renderTableBody();

        // Clear filters
        document.getElementById('clearFiltersBtn').addEventListener('click', () => {
            document.querySelectorAll('.filter-input').forEach(input => input.value = '');
            applyFiltersAndSort();
        });

        // Clear sort
        document.getElementById('clearSortBtn').addEventListener('click', () => {
            sortStack = [];
            updateSortIndicators();
            applyFiltersAndSort();
        });

        // Refresh
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });

        // Filter inputs with debouncing
        document.querySelectorAll('.filter-input').forEach(input => {
            input.addEventListener('input', () => {
                // Clear existing timer
                if (filterDebounceTimer) {
                    clearTimeout(filterDebounceTimer);
                }
                // Set new timer - wait 300ms after user stops typing
                filterDebounceTimer = setTimeout(() => {
                    applyFiltersAndSort();
                }, 300);
            });
        });

        // Sorting - click on header (with debouncing for large datasets)
        document.querySelectorAll('.header-row th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                if (e.target.classList.contains('resize-handle')) return;
                const col = parseInt(th.dataset.col);
                
                // Check if this column is already in sort stack
                const existingIndex = sortStack.findIndex(s => s.col === col);
                
                if (existingIndex === 0) {
                    // Primary sort - toggle direction or remove
                    if (sortStack[0].dir === 'asc') {
                        sortStack[0].dir = 'desc';
                    } else {
                        sortStack.shift(); // Remove from stack
                    }
                } else if (existingIndex > 0) {
                    // Already in stack but not primary - move to primary
                    const item = sortStack.splice(existingIndex, 1)[0];
                    item.dir = 'asc';
                    sortStack.unshift(item);
                } else {
                    // New column - add as primary sort
                    sortStack.unshift({ col, dir: 'asc' });
                }
                
                // Limit sort stack to 3 levels
                if (sortStack.length > 3) sortStack.pop();
                
                updateSortIndicators();
                
                // Show loading indicator for large datasets
                if (originalRows.length > 5000) {
                    document.getElementById('statusBar').textContent = 'Sorting...';
                    // Use setTimeout to let UI update before sorting
                    setTimeout(() => applyFiltersAndSort(), 10);
                } else {
                    applyFiltersAndSort();
                }
            });
        });

        function updateSortIndicators() {
            document.querySelectorAll('.header-row th.sortable').forEach(th => {
                const col = parseInt(th.dataset.col);
                const indicator = th.querySelector('.sort-indicator');
                const sortIndex = sortStack.findIndex(s => s.col === col);
                
                if (sortIndex >= 0) {
                    const sort = sortStack[sortIndex];
                    const arrow = sort.dir === 'asc' ? '▲' : '▼';
                    const order = sortStack.length > 1 ? '<span class="sort-order">' + (sortIndex + 1) + '</span>' : '';
                    indicator.innerHTML = arrow + order;
                } else {
                    indicator.innerHTML = '';
                }
            });
            
            // Update sort info
            const sortInfo = document.getElementById('sortInfo');
            if (sortStack.length > 0) {
                const sortDesc = sortStack.map((s, i) => {
                    const colName = columns[s.col];
                    const dir = s.dir === 'asc' ? '↑' : '↓';
                    return colName + dir;
                }).join(' → ');
                sortInfo.textContent = 'Sort: ' + sortDesc;
            } else {
                sortInfo.textContent = '';
            }
        }

        function applyFiltersAndSort() {
            // Reset visible range for virtual scrolling
            visibleStartIndex = 0;
            visibleEndIndex = ROWS_PER_BATCH;
            
            // Get filters
            const filters = {};
            document.querySelectorAll('.filter-input').forEach(input => {
                const col = parseInt(input.dataset.col);
                const value = input.value.toLowerCase().trim();
                if (value) filters[col] = value;
            });

            // Filter rows - optimize by mapping once
            const filterCols = Object.keys(filters);
            let filtered;
            
            if (filterCols.length === 0) {
                // No filters - just map with index
                filtered = originalRows.map((row, i) => ({ data: row, originalIndex: i }));
            } else {
                // Apply filters
                filtered = [];
                for (let i = 0; i < originalRows.length; i++) {
                    const row = originalRows[i];
                    let match = true;
                    
                    for (const col of filterCols) {
                        const cellValue = (row[col] || '').toLowerCase();
                        if (!cellValue.includes(filters[col])) {
                            match = false;
                            break;
                        }
                    }
                    
                    if (match) {
                        filtered.push({ data: row, originalIndex: i });
                    }
                }
            }

            // Sort rows (multi-level)
            if (sortStack.length > 0) {
                filtered.sort((a, b) => {
                    for (const sort of sortStack) {
                        const valA = a.data[sort.col] || '';
                        const valB = b.data[sort.col] || '';
                        
                        // Try numeric comparison
                        const numA = parseFloat(valA);
                        const numB = parseFloat(valB);
                        
                        let cmp = 0;
                        if (!isNaN(numA) && !isNaN(numB)) {
                            cmp = numA - numB;
                        } else {
                            cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
                        }
                        
                        if (cmp !== 0) {
                            return sort.dir === 'asc' ? cmp : -cmp;
                        }
                    }
                    return 0;
                });
            }

            displayRows = filtered;
            renderTableBody();
        }

        function renderTableBody() {
            const tbody = document.getElementById('tableBody');
            
            // Virtual scrolling - only render visible rows
            const totalRows = displayRows.length;
            const endIndex = Math.min(visibleEndIndex, totalRows);
            
            // Build HTML efficiently with array join
            const rowsHtml = [];
            
            for (let i = visibleStartIndex; i < endIndex; i++) {
                const row = displayRows[i];
                const cells = ['<tr data-original="' + row.originalIndex + '">'];
                cells.push('<td class="row-number">' + (row.originalIndex + 1) + '</td>');
                
                for (let j = 0; j < row.data.length; j++) {
                    const cell = row.data[j];
                    const cellText = escapeHtml(String(cell || ''));
                    cells.push('<td title="' + cellText + '">' + cellText + '</td>');
                }
                cells.push('</tr>');
                rowsHtml.push(cells.join(''));
            }
            
            tbody.innerHTML = rowsHtml.join('');
            document.getElementById('statusBar').textContent = 'Showing ' + displayRows.length + ' of ' + originalRows.length + ' rows';
            
            // If we have more rows to display, set up infinite scroll
            if (displayRows.length > ROWS_PER_BATCH) {
                setupInfiniteScroll();
            }
        }
        
        function setupInfiniteScroll() {
            const tableContainer = document.querySelector('.table-container');
            let scrollTimeout;
            
            // Remove existing listener if any
            const oldListener = tableContainer.onscroll;
            
            tableContainer.onscroll = function() {
                // Debounce scroll events
                if (scrollTimeout) {
                    clearTimeout(scrollTimeout);
                }
                
                scrollTimeout = setTimeout(() => {
                    const scrollHeight = tableContainer.scrollHeight;
                    const scrollTop = tableContainer.scrollTop;
                    const clientHeight = tableContainer.clientHeight;
                    
                    // Load more rows when scrolled near bottom
                    if (scrollTop + clientHeight >= scrollHeight - 200) {
                        if (visibleEndIndex < displayRows.length) {
                            visibleEndIndex = Math.min(visibleEndIndex + ROWS_PER_BATCH, displayRows.length);
                            renderMoreRows();
                        }
                    }
                }, 100);
            };
        }
        
        function renderMoreRows() {
            const tbody = document.getElementById('tableBody');
            const currentEnd = tbody.children.length + visibleStartIndex;
            const newEnd = Math.min(visibleEndIndex, displayRows.length);
            
            // Append new rows efficiently
            const fragment = document.createDocumentFragment();
            
            for (let i = currentEnd; i < newEnd; i++) {
                const row = displayRows[i];
                const tr = document.createElement('tr');
                tr.dataset.original = row.originalIndex;
                
                let html = '<td class="row-number">' + (row.originalIndex + 1) + '</td>';
                row.data.forEach(cell => {
                    const cellText = escapeHtml(String(cell || ''));
                    html += '<td title="' + cellText + '">' + cellText + '</td>';
                });
                tr.innerHTML = html;
                fragment.appendChild(tr);
            }
            
            tbody.appendChild(fragment);
        }

        function escapeHtml(text) {
            if (text === null || text === undefined) return '';
            const div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        }

        // Column resizing
        let isResizing = false;
        let currentCol = null;
        let startX = 0;
        let startWidth = 0;

        document.querySelectorAll('.resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                isResizing = true;
                currentCol = parseInt(handle.dataset.col);
                startX = e.pageX;
                
                // Get all cells in this column (both header rows)
                const table = document.getElementById('dataTable');
                const filterTh = table.querySelector('.filter-row th:nth-child(' + (currentCol + 2) + ')');
                const headerTh = table.querySelector('.header-row th:nth-child(' + (currentCol + 2) + ')');
                startWidth = headerTh.offsetWidth;
                
                handle.classList.add('resizing');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            });
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const diff = e.pageX - startX;
            const newWidth = Math.max(60, startWidth + diff);
            
            // Update column width
            const table = document.getElementById('dataTable');
            const filterTh = table.querySelector('.filter-row th:nth-child(' + (currentCol + 2) + ')');
            const headerTh = table.querySelector('.header-row th:nth-child(' + (currentCol + 2) + ')');
            
            filterTh.style.width = newWidth + 'px';
            filterTh.style.minWidth = newWidth + 'px';
            headerTh.style.width = newWidth + 'px';
            headerTh.style.minWidth = newWidth + 'px';
            
            // Update body cells
            const bodyCells = table.querySelectorAll('tbody td:nth-child(' + (currentCol + 2) + ')');
            bodyCells.forEach(cell => {
                cell.style.width = newWidth + 'px';
                cell.style.minWidth = newWidth + 'px';
                cell.style.maxWidth = newWidth + 'px';
            });
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.querySelectorAll('.resize-handle').forEach(h => h.classList.remove('resizing'));
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    </script>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

/**
 * RStudio-style Code Section Folding Provider
 * 
 * Detects code sections marked by:
 * - Lines starting with # followed by 3+ # characters (e.g., #### Section ####)
 * - Lines ending with 4+ dashes (e.g., # Section ----)
 * 
 * Each section folds from its header line to the line before the next section header.
 */
class RCodeSectionFoldingProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        context: vscode.FoldingContext,
        token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        const sectionStarts: number[] = [];

        console.log('RCodeSectionFoldingProvider: scanning document with', document.lineCount, 'lines');

        // Find all section header lines
        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            
            // Check for RStudio-style section markers:
            // 1. Lines ending with 4+ dashes: # Section ----
            // 2. Lines starting with 4+ hashes: #### Section
            const endsWithDashes = /^#.*-{4,}\s*$/.test(lineText);
            const startsWithHashes = /^#{4,}/.test(lineText.trim());
            
            if (endsWithDashes || startsWithHashes) {
                console.log('Found section at line', i, ':', lineText);
                sectionStarts.push(i);
            }
        }

        console.log('Found', sectionStarts.length, 'sections');

        // Create folding ranges from each section start to the next section (or end of file)
        for (let i = 0; i < sectionStarts.length; i++) {
            const startLine = sectionStarts[i];
            // End at the line before the next section, or at the last line of the file
            const endLine = i < sectionStarts.length - 1 
                ? sectionStarts[i + 1] - 1 
                : document.lineCount - 1;

            // Only create a range if there's at least one line to fold
            if (endLine > startLine) {
                console.log('Creating fold range:', startLine, '-', endLine);
                ranges.push(new vscode.FoldingRange(
                    startLine, 
                    endLine, 
                    vscode.FoldingRangeKind.Region
                ));
            }
        }

        return ranges;
    }
}

class TibbleHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_.][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        
        // Check if this might be a tibble
        if (mightBeTibble(document, word)) {
            const markdown = new vscode.MarkdownString();
            markdown.appendMarkdown(`**${word}** (tibble/data.frame)\n\n`);
            // Command URIs need arguments as an array
            const args = encodeURIComponent(JSON.stringify([word]));
            markdown.appendMarkdown(`[📊 Open in Data Explorer](command:rview.openInDataExplorer?${args}) | `);
            markdown.appendMarkdown(`[📋 Simple Viewer](command:rview.openSimpleViewer?${args})`);
            markdown.isTrusted = true;
            
            return new vscode.Hover(markdown, wordRange);
        }

        return null;
    }
}

class TibbleDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.LocationLink[] | null> {
        
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_.][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        
        // Check if this might be a tibble
        if (mightBeTibble(document, word)) {
            // Open in Data Explorer
            await openInDataExplorer(word);
        }

        // Return null - we don't want to navigate anywhere
        return null;
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Show activation message
    vscode.window.showInformationMessage('Positron Tibble Explorer activated!');
    console.log('Rview is now active!');

    // Register the main command to open tibble in data explorer
    const openCommand = vscode.commands.registerCommand(
        'rview.openInDataExplorer',
        async (variableName?: string) => {
            console.log('openInDataExplorer called with:', variableName);
            
            if (!variableName) {
                // Get the word under cursor
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor');
                    return;
                }

                const position = editor.selection.active;
                const wordRange = editor.document.getWordRangeAtPosition(position, /[a-zA-Z_.][a-zA-Z0-9_.]*/);
                if (!wordRange) {
                    vscode.window.showErrorMessage('No variable name at cursor position');
                    return;
                }

                variableName = editor.document.getText(wordRange);
            }

            await openInDataExplorer(variableName);
        }
    );
    context.subscriptions.push(openCommand);

    // Register test command that shows available commands
    const testCommand = vscode.commands.registerCommand(
        'rview.testActivation',
        async () => {
            vscode.window.showInformationMessage('Rview is working!');
            
            // List all available commands that might be relevant
            const allCommands = await vscode.commands.getCommands(true);
            const relevantCommands = allCommands.filter(c => 
                c.toLowerCase().includes('positron') || 
                c.startsWith('r.') ||
                c.includes('console') ||
                c.includes('executeCode')
            ).sort();
            
            console.log('=== RELEVANT COMMANDS FOR R/POSITRON ===');
            relevantCommands.forEach(c => console.log(c));
            console.log('=========================================');
            
            // Show quick pick to test
            const choice = await vscode.window.showQuickPick([
                '🧪 Test with mtcars (built-in R dataset)',
                '📋 Copy command list to clipboard',
                '❌ Cancel'
            ], { placeHolder: 'What would you like to test?' });
            
            if (choice?.includes('mtcars')) {
                await openInDataExplorer('mtcars');
            } else if (choice?.includes('Copy')) {
                await vscode.env.clipboard.writeText(relevantCommands.join('\n'));
                vscode.window.showInformationMessage(`Copied ${relevantCommands.length} commands to clipboard. Check Developer Tools console for details.`);
            }
        }
    );
    context.subscriptions.push(testCommand);

    // Register simple data viewer command
    const simpleViewerCommand = vscode.commands.registerCommand(
        'rview.openSimpleViewer',
        async (variableName?: string) => {
            if (!variableName) {
                // Get the word under cursor
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor');
                    return;
                }

                const position = editor.selection.active;
                const wordRange = editor.document.getWordRangeAtPosition(position, /[a-zA-Z_.][a-zA-Z0-9_.]*/);
                if (!wordRange) {
                    vscode.window.showErrorMessage('No variable name at cursor position');
                    return;
                }

                variableName = editor.document.getText(wordRange);
            }

            await SimpleDataViewerPanel.createOrShow(context.extensionUri, variableName);
        }
    );
    context.subscriptions.push(simpleViewerCommand);

    // Register hover provider
    const hoverProvider = new TibbleHoverProvider();
    const rSelector: vscode.DocumentSelector = [
        { language: 'r', scheme: 'file' },
        { language: 'r', scheme: 'untitled' },
        { language: 'rmd', scheme: 'file' },
        { language: 'rmd', scheme: 'untitled' },
        { language: 'quarto', scheme: 'file' },
        { language: 'quarto', scheme: 'untitled' },
    ];
    
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(rSelector, hoverProvider)
    );

    // Register definition provider (for Ctrl+Click)
    const definitionProvider = new TibbleDefinitionProvider();
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(rSelector, definitionProvider)
    );

    // Register folding range provider for RStudio-style code sections
    const foldingProvider = new RCodeSectionFoldingProvider();
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(rSelector, foldingProvider)
    );

    vscode.commands.executeCommand('setContext', 'positronTibbleExplorer.active', true);
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'positronTibbleExplorer.active', false);
}
