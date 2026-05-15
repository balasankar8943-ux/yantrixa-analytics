/* ============================================
   YANTRIXA ANALYTICS — App Engine
   CSV Parser, KPIs, Charts, Filters, Export
   ============================================ */

// ---- Global State ----
const AppState = {
    rawData: [],
    filteredData: [],
    headers: [],
    numericCols: [],
    dateCols: [],
    stringCols: [],
    activeColumn: '',
    activeCategoryCol: '',
    activeDateCol: '',
    filters: {
        search: '',
        dateFrom: '',
        dateTo: '',
    },
    charts: {
        bar: null,
        line: null,
        pie: null,
    },
};

// ---- Chart Color Palette ----
const CHART_COLORS = [
    'rgba(0, 212, 255, 0.85)',
    'rgba(0, 119, 182, 0.85)',
    'rgba(0, 230, 118, 0.85)',
    'rgba(255, 171, 64, 0.85)',
    'rgba(179, 136, 255, 0.85)',
    'rgba(255, 128, 171, 0.85)',
    'rgba(255, 215, 64, 0.85)',
    'rgba(100, 181, 246, 0.85)',
    'rgba(129, 199, 132, 0.85)',
    'rgba(239, 154, 154, 0.85)',
];

const CHART_BORDERS = CHART_COLORS.map(c => c.replace('0.85', '1'));

// ============================================
//  INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initSidebar();
    initFileUpload();
    initFilters();
    initExport();
});

// ============================================
//  SIDEBAR
// ============================================
function initSidebar() {
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const links = document.querySelectorAll('.sidebar-link');

    if (toggle) {
        toggle.addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });
    }

    links.forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('open');
            }
        });
    });
}

// ============================================
//  FILE UPLOAD & DROP ZONE
// ============================================
function initFileUpload() {
    const fileInput = document.getElementById('csv-file-input');
    const uploadBtn = document.getElementById('btn-upload');
    const dropZone = document.getElementById('drop-zone');

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    if (dropZone) {
        dropZone.addEventListener('click', () => fileInput.click());

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });
    }
}

function handleFile(file) {
    const fileName = file.name.toLowerCase();
    const isCSV = fileName.endsWith('.csv');
    const isPDF = fileName.endsWith('.pdf');

    if (!isCSV && !isPDF) {
        showToast('error', 'Invalid file type. Please upload a .csv or .pdf file.');
        return;
    }

    if (file.size === 0) {
        showToast('error', 'The file is empty. Please choose a valid file.');
        return;
    }

    if (file.size > 50 * 1024 * 1024) {
        showToast('error', 'File too large (max 50MB).');
        return;
    }

    showLoading(true);

    if (isPDF) {
        handlePDFFile(file);
    } else {
        handleCSVFile(file);
    }
}

function handleCSVFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const text = e.target.result;
            const data = parseCSV(text);
            loadParsedData(data, 'CSV');
        } catch (err) {
            showLoading(false);
            showToast('error', 'Failed to parse CSV: ' + err.message);
        }
    };
    reader.onerror = () => {
        showLoading(false);
        showToast('error', 'Failed to read file.');
    };
    reader.readAsText(file);
}

async function handlePDFFile(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();

        // Configure pdf.js worker
        if (typeof pdfjsLib !== 'undefined') {
            pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        } else {
            showLoading(false);
            showToast('error', 'PDF library failed to load. Please refresh and try again.');
            return;
        }

        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const allLines = [];

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();

            // Group text items by their vertical position (y coordinate) to reconstruct rows
            const lineMap = {};
            textContent.items.forEach(item => {
                const y = Math.round(item.transform[5]); // y-coordinate
                if (!lineMap[y]) lineMap[y] = [];
                lineMap[y].push({
                    x: item.transform[4],
                    text: item.str
                });
            });

            // Sort lines top-to-bottom (higher y = higher on page)
            const sortedYs = Object.keys(lineMap).map(Number).sort((a, b) => b - a);

            sortedYs.forEach(y => {
                // Sort items left-to-right within each line
                const items = lineMap[y].sort((a, b) => a.x - b.x);
                const lineText = items.map(it => it.text).join('\t');
                if (lineText.trim()) {
                    allLines.push(lineText);
                }
            });
        }

        if (allLines.length < 2) {
            showLoading(false);
            showToast('error', 'Could not extract enough tabular data from the PDF.');
            return;
        }

        // Try to parse as tabular data
        const data = parsePDFLines(allLines);
        loadParsedData(data, 'PDF');

    } catch (err) {
        showLoading(false);
        showToast('error', 'Failed to parse PDF: ' + err.message);
    }
}

function parsePDFLines(lines) {
    const rows = [];

    // Detect delimiter: tab, pipe, or multi-space
    let delimiter = '\t';
    const firstLine = lines[0];

    if (firstLine.includes('|')) {
        delimiter = '|';
    } else if (firstLine.includes('\t')) {
        delimiter = '\t';
    } else if (firstLine.match(/\s{2,}/)) {
        delimiter = 'MULTI_SPACE';
    }

    lines.forEach(line => {
        let cells;
        if (delimiter === 'MULTI_SPACE') {
            cells = line.split(/\s{2,}/).map(c => c.trim()).filter(c => c !== '');
        } else {
            cells = line.split(delimiter).map(c => c.trim()).filter(c => c !== '');
        }

        // Skip separator lines (e.g., "---+---+---")
        if (cells.length > 0 && !cells.every(c => /^[-=+|_\s]+$/.test(c))) {
            rows.push(cells);
        }
    });

    // Normalize column count to the most common column count (the mode)
    const colCounts = {};
    rows.forEach(r => {
        colCounts[r.length] = (colCounts[r.length] || 0) + 1;
    });
    const targetCols = Number(Object.entries(colCounts).sort((a, b) => b[1] - a[1])[0][0]);

    // Keep only rows matching the target column count
    const normalized = rows.filter(r => r.length === targetCols);

    return normalized;
}

function loadParsedData(data, sourceType) {
    if (data.length < 2) {
        showLoading(false);
        showToast('error', `${sourceType} must have at least a header row and one data row.`);
        return;
    }

    AppState.headers = data[0].map(h => h.trim()).map((h, i) => h || `Column ${i + 1}`);
    AppState.rawData = data.slice(1).map(row => {
        const obj = {};
        AppState.headers.forEach((h, i) => {
            obj[h] = row[i] !== undefined ? String(row[i]).trim() : '';
        });
        return obj;
    });

    detectColumnTypes();

    if (AppState.numericCols.length === 0) {
        showLoading(false);
        showToast('error', `No numeric columns found in the ${sourceType}.`);
        return;
    }

    AppState.activeColumn = AppState.numericCols[0];
    AppState.activeCategoryCol = AppState.stringCols.length > 0 ? AppState.stringCols[0] : '';
    AppState.activeDateCol = AppState.dateCols.length > 0 ? AppState.dateCols[0] : '';

    AppState.filters = { search: '', dateFrom: '', dateTo: '' };

    populateFilterDropdowns();
    applyFilters();
    showDashboard();

    setTimeout(() => {
        showLoading(false);
        showToast('success', `Loaded ${AppState.rawData.length} rows with ${AppState.headers.length} columns from ${sourceType}.`);
    }, 400);
}

// ============================================
//  CSV PARSER
// ============================================
function parseCSV(text) {
    const rows = [];
    let current = '';
    let inQuotes = false;
    let row = [];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                current += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                row.push(current);
                current = '';
            } else if (ch === '\r' && next === '\n') {
                row.push(current);
                current = '';
                if (row.length > 0) rows.push(row);
                row = [];
                i++;
            } else if (ch === '\n' || ch === '\r') {
                row.push(current);
                current = '';
                if (row.length > 0) rows.push(row);
                row = [];
            } else {
                current += ch;
            }
        }
    }

    row.push(current);
    if (row.some(cell => cell.trim() !== '')) rows.push(row);

    return rows;
}

// ============================================
//  COLUMN TYPE DETECTION
// ============================================
function detectColumnTypes() {
    AppState.numericCols = [];
    AppState.dateCols = [];
    AppState.stringCols = [];

    const sampleSize = Math.min(AppState.rawData.length, 20);

    AppState.headers.forEach(header => {
        let numCount = 0;
        let dateCount = 0;

        for (let i = 0; i < sampleSize; i++) {
            const val = AppState.rawData[i][header];
            if (!val || val.trim() === '') continue;

            if (isNumericValue(val)) numCount++;
            else if (isDateValue(val)) dateCount++;
        }

        const threshold = sampleSize * 0.5;
        if (numCount >= threshold) {
            AppState.numericCols.push(header);
        } else if (dateCount >= threshold) {
            AppState.dateCols.push(header);
        } else {
            AppState.stringCols.push(header);
        }
    });
}

function isNumericValue(val) {
    const cleaned = val.replace(/[$€₹£¥,\s]/g, '').trim();
    return cleaned !== '' && !isNaN(Number(cleaned));
}

function isDateValue(val) {
    const patterns = [
        /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,
        /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/,
        /^\d{1,2}\s\w+\s\d{4}$/,
        /^\w+\s\d{1,2},?\s\d{4}$/,
    ];
    return patterns.some(p => p.test(val.trim())) && !isNaN(Date.parse(val));
}

function parseNumeric(val) {
    if (val === null || val === undefined || val === '') return NaN;
    const cleaned = String(val).replace(/[$€₹£¥,\s]/g, '').trim();
    return Number(cleaned);
}

// ============================================
//  FILTERS
// ============================================
function initFilters() {
    const searchInput = document.getElementById('filter-search');
    const dateFrom = document.getElementById('filter-date-from');
    const dateTo = document.getElementById('filter-date-to');
    const colSelect = document.getElementById('filter-column');
    const catSelect = document.getElementById('filter-category-col');
    const clearBtn = document.getElementById('btn-clear-filters');

    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            AppState.filters.search = e.target.value;
            applyFilters();
        }, 300);
    });

    dateFrom.addEventListener('change', (e) => {
        AppState.filters.dateFrom = e.target.value;
        applyFilters();
    });

    dateTo.addEventListener('change', (e) => {
        AppState.filters.dateTo = e.target.value;
        applyFilters();
    });

    colSelect.addEventListener('change', (e) => {
        AppState.activeColumn = e.target.value;
        applyFilters();
    });

    catSelect.addEventListener('change', (e) => {
        AppState.activeCategoryCol = e.target.value;
        applyFilters();
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        dateFrom.value = '';
        dateTo.value = '';
        AppState.filters = { search: '', dateFrom: '', dateTo: '' };
        applyFilters();
        showToast('info', 'All filters cleared.');
    });
}

function populateFilterDropdowns() {
    const colSelect = document.getElementById('filter-column');
    const catSelect = document.getElementById('filter-category-col');
    const dateControls = document.getElementById('date-filter-group');

    colSelect.innerHTML = '';
    AppState.numericCols.forEach(col => {
        const opt = document.createElement('option');
        opt.value = col;
        opt.textContent = col;
        if (col === AppState.activeColumn) opt.selected = true;
        colSelect.appendChild(opt);
    });

    catSelect.innerHTML = '';
    const allCats = [...AppState.stringCols, ...AppState.dateCols];
    allCats.forEach(col => {
        const opt = document.createElement('option');
        opt.value = col;
        opt.textContent = col;
        catSelect.appendChild(opt);
    });
    if (allCats.length > 0) {
        AppState.activeCategoryCol = allCats[0];
    }

    if (AppState.dateCols.length > 0) {
        dateControls.style.display = 'flex';
    } else {
        dateControls.style.display = 'none';
    }
}

function applyFilters() {
    let data = [...AppState.rawData];

    // Search filter
    if (AppState.filters.search) {
        const q = AppState.filters.search.toLowerCase();
        data = data.filter(row =>
            Object.values(row).some(v => String(v).toLowerCase().includes(q))
        );
    }

    // Date range filter
    if (AppState.dateCols.length > 0 && (AppState.filters.dateFrom || AppState.filters.dateTo)) {
        const dateCol = AppState.dateCols[0];
        data = data.filter(row => {
            const d = new Date(row[dateCol]);
            if (isNaN(d)) return true;
            if (AppState.filters.dateFrom && d < new Date(AppState.filters.dateFrom)) return false;
            if (AppState.filters.dateTo && d > new Date(AppState.filters.dateTo + 'T23:59:59')) return false;
            return true;
        });
    }

    AppState.filteredData = data;
    updateKPIs();
    updateCharts();
    updateTable();
}

// ============================================
//  KPI CARDS
// ============================================
function updateKPIs() {
    const data = AppState.filteredData;
    const col = AppState.activeColumn;
    const values = data.map(r => parseNumeric(r[col])).filter(v => !isNaN(v));

    const total = values.reduce((a, b) => a + b, 0);
    const avg = values.length > 0 ? total / values.length : 0;
    const max = values.length > 0 ? Math.max(...values) : 0;
    const min = values.length > 0 ? Math.min(...values) : 0;

    animateValue('kpi-total', total);
    animateValue('kpi-avg', avg);
    animateValue('kpi-max', max);
    animateValue('kpi-min', min);

    document.getElementById('kpi-total-sub').textContent = `${values.length} records · ${col}`;
    document.getElementById('kpi-avg-sub').textContent = `Mean of ${col}`;
    document.getElementById('kpi-max-sub').textContent = `Highest in ${col}`;
    document.getElementById('kpi-min-sub').textContent = `Lowest in ${col}`;
}

function animateValue(elementId, target) {
    const el = document.getElementById(elementId);
    const duration = 800;
    const startTime = performance.now();
    const start = 0;

    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = start + (target - start) * eased;
        el.textContent = formatNumber(current);
        if (progress < 1) requestAnimationFrame(step);
        else el.textContent = formatNumber(target);
    }

    requestAnimationFrame(step);
}

function formatNumber(num) {
    if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (Math.abs(num) >= 1e4) return (num / 1e3).toFixed(1) + 'K';
    if (Number.isInteger(num)) return num.toLocaleString();
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ============================================
//  CHARTS
// ============================================
function getChartDefaults() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 1000, easing: 'easeOutQuart' },
        plugins: {
            legend: {
                labels: {
                    color: '#9090a8',
                    font: { family: "'Rajdhani', sans-serif", size: 12 },
                    padding: 16,
                },
            },
            tooltip: {
                backgroundColor: 'rgba(10, 10, 20, 0.9)',
                titleColor: '#e8e8f0',
                bodyColor: '#9090a8',
                borderColor: 'rgba(0, 212, 255, 0.2)',
                borderWidth: 1,
                cornerRadius: 8,
                padding: 12,
                titleFont: { family: "'Rajdhani', sans-serif", weight: '600' },
                bodyFont: { family: "'Inter', sans-serif" },
            },
        },
        scales: {
            x: {
                ticks: { color: '#606078', font: { family: "'Rajdhani', sans-serif", size: 11 } },
                grid: { color: 'rgba(255,255,255,0.03)' },
                border: { color: 'rgba(255,255,255,0.06)' },
            },
            y: {
                ticks: { color: '#606078', font: { family: "'Rajdhani', sans-serif", size: 11 } },
                grid: { color: 'rgba(255,255,255,0.03)' },
                border: { color: 'rgba(255,255,255,0.06)' },
            },
        },
    };
}

function updateCharts() {
    updateBarChart();
    updateLineChart();
    updatePieChart();
}

function updateBarChart() {
    const ctx = document.getElementById('chart-bar').getContext('2d');

    if (AppState.charts.bar) AppState.charts.bar.destroy();

    const catCol = AppState.activeCategoryCol;
    const valCol = AppState.activeColumn;
    const data = AppState.filteredData;

    // Aggregate by category
    const agg = {};
    data.forEach(row => {
        const cat = row[catCol] || 'Unknown';
        const val = parseNumeric(row[valCol]);
        if (!isNaN(val)) {
            agg[cat] = (agg[cat] || 0) + val;
        }
    });

    let labels = Object.keys(agg);
    let values = Object.values(agg);

    // Limit to top 15 categories
    if (labels.length > 15) {
        const sorted = labels.map((l, i) => ({ l, v: values[i] }))
            .sort((a, b) => b.v - a.v).slice(0, 15);
        labels = sorted.map(s => s.l);
        values = sorted.map(s => s.v);
    }

    const defaults = getChartDefaults();
    AppState.charts.bar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: valCol,
                data: values,
                backgroundColor: labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
                borderColor: labels.map((_, i) => CHART_BORDERS[i % CHART_BORDERS.length]),
                borderWidth: 1,
                borderRadius: 6,
                borderSkipped: false,
            }],
        },
        options: {
            ...defaults,
            plugins: {
                ...defaults.plugins,
                legend: { display: false },
            },
        },
    });
}

function updateLineChart() {
    const ctx = document.getElementById('chart-line').getContext('2d');

    if (AppState.charts.line) AppState.charts.line.destroy();

    const valCol = AppState.activeColumn;
    const data = AppState.filteredData;
    let labels, values;

    if (AppState.dateCols.length > 0) {
        const dateCol = AppState.dateCols[0];
        const sorted = [...data].sort((a, b) => new Date(a[dateCol]) - new Date(b[dateCol]));
        labels = sorted.map(r => {
            const d = new Date(r[dateCol]);
            return isNaN(d) ? r[dateCol] : d.toLocaleDateString();
        });
        values = sorted.map(r => parseNumeric(r[valCol]));
    } else {
        labels = data.map((_, i) => `Row ${i + 1}`);
        values = data.map(r => parseNumeric(r[valCol]));
    }

    // Sample if too many points
    if (labels.length > 100) {
        const step = Math.ceil(labels.length / 100);
        labels = labels.filter((_, i) => i % step === 0);
        values = values.filter((_, i) => i % step === 0);
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(0, 212, 255, 0.25)');
    gradient.addColorStop(1, 'rgba(0, 212, 255, 0)');

    const defaults = getChartDefaults();
    AppState.charts.line = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: valCol,
                data: values,
                borderColor: '#00d4ff',
                backgroundColor: gradient,
                fill: true,
                tension: 0.4,
                pointRadius: labels.length > 30 ? 0 : 3,
                pointHoverRadius: 6,
                pointBackgroundColor: '#00d4ff',
                pointBorderColor: '#050508',
                pointBorderWidth: 2,
                borderWidth: 2,
            }],
        },
        options: {
            ...defaults,
            plugins: {
                ...defaults.plugins,
                legend: { display: false },
            },
        },
    });
}

function updatePieChart() {
    const ctx = document.getElementById('chart-pie').getContext('2d');

    if (AppState.charts.pie) AppState.charts.pie.destroy();

    const catCol = AppState.activeCategoryCol;
    const data = AppState.filteredData;

    // Count occurrences
    const counts = {};
    data.forEach(row => {
        const cat = row[catCol] || 'Unknown';
        counts[cat] = (counts[cat] || 0) + 1;
    });

    let labels = Object.keys(counts);
    let values = Object.values(counts);

    // Limit to top 8, group rest as "Other"
    if (labels.length > 8) {
        const sorted = labels.map((l, i) => ({ l, v: values[i] }))
            .sort((a, b) => b.v - a.v);
        const top = sorted.slice(0, 7);
        const otherVal = sorted.slice(7).reduce((a, b) => a + b.v, 0);
        labels = [...top.map(s => s.l), 'Other'];
        values = [...top.map(s => s.v), otherVal];
    }

    const defaults = getChartDefaults();
    AppState.charts.pie = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
                borderColor: '#0a0a10',
                borderWidth: 2,
                hoverOffset: 8,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: defaults.animation,
            plugins: {
                ...defaults.plugins,
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#9090a8',
                        font: { family: "'Rajdhani', sans-serif", size: 11 },
                        padding: 12,
                        usePointStyle: true,
                        pointStyleWidth: 10,
                    },
                },
            },
            cutout: '55%',
        },
    });
}

// ============================================
//  DATA TABLE
// ============================================
function updateTable() {
    const thead = document.getElementById('table-head');
    const tbody = document.getElementById('table-body');
    const info = document.getElementById('table-info');

    thead.innerHTML = '';
    tbody.innerHTML = '';

    const tr = document.createElement('tr');
    AppState.headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        tr.appendChild(th);
    });
    thead.appendChild(tr);

    const displayData = AppState.filteredData.slice(0, 200);
    displayData.forEach(row => {
        const tr = document.createElement('tr');
        AppState.headers.forEach(h => {
            const td = document.createElement('td');
            td.textContent = row[h];
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    const total = AppState.filteredData.length;
    info.textContent = total > 200
        ? `Showing 200 of ${total.toLocaleString()} rows`
        : `${total.toLocaleString()} rows`;
}

// ============================================
//  EXPORT
// ============================================
function initExport() {
    document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
    document.getElementById('btn-export-pdf').addEventListener('click', exportPDF);
    document.getElementById('btn-copy-clipboard').addEventListener('click', copyToClipboard);
    document.getElementById('btn-export-bar').addEventListener('click', () => exportChartPNG('bar'));
    document.getElementById('btn-export-line').addEventListener('click', () => exportChartPNG('line'));
    document.getElementById('btn-export-pie').addEventListener('click', () => exportChartPNG('pie'));
    document.getElementById('btn-clear-dashboard').addEventListener('click', clearDashboard);
}

function exportCSV() {
    if (AppState.filteredData.length === 0) {
        showToast('error', 'No data to export.');
        return;
    }

    const header = AppState.headers.join(',');
    const rows = AppState.filteredData.map(row =>
        AppState.headers.map(h => {
            let val = String(row[h]);
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                val = '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        }).join(',')
    );

    const csvContent = [header, ...rows].join('\r\n');
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const fileName = 'yantrixa-export-' + new Date().toISOString().slice(0, 10) + '.csv';

    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName;
    a.setAttribute('download', fileName);
    document.body.appendChild(a);
    a.click();

    setTimeout(function() {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 2000);

    showToast('success', 'Exported ' + AppState.filteredData.length + ' rows as ' + fileName);
}

function exportPDF() {
    if (AppState.filteredData.length === 0) {
        showToast('error', 'No data to export.');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const timestamp = new Date().toLocaleString();

    // ---- Header ----
    doc.setFillColor(5, 5, 8);
    doc.rect(0, 0, pageWidth, 28, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(0, 212, 255);
    doc.text('YANTRIXA ANALYTICS', 14, 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(144, 144, 168);
    doc.text('Business Intelligence Report', 14, 21);
    doc.text(`Generated: ${timestamp}`, pageWidth - 14, 14, { align: 'right' });
    doc.text(`${AppState.filteredData.length} rows | ${AppState.headers.length} columns`, pageWidth - 14, 21, { align: 'right' });

    // ---- KPI Summary ----
    const col = AppState.activeColumn;
    const values = AppState.filteredData.map(r => parseNumeric(r[col])).filter(v => !isNaN(v));
    const total = values.reduce((a, b) => a + b, 0);
    const avg = values.length > 0 ? total / values.length : 0;
    const max = values.length > 0 ? Math.max(...values) : 0;
    const min = values.length > 0 ? Math.min(...values) : 0;

    let kpiY = 35;
    doc.setFillColor(15, 15, 25);
    doc.roundedRect(14, kpiY - 2, pageWidth - 28, 16, 2, 2, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(96, 96, 120);
    doc.text('METRIC:', 18, kpiY + 4);
    doc.setTextColor(232, 232, 240);
    doc.text(col, 38, kpiY + 4);

    const kpiItems = [
        { label: 'TOTAL', value: formatNumber(total) },
        { label: 'AVERAGE', value: formatNumber(avg) },
        { label: 'MAX', value: formatNumber(max) },
        { label: 'MIN', value: formatNumber(min) },
    ];

    const kpiStartX = pageWidth - 14;
    kpiItems.reverse().forEach((item, i) => {
        const x = kpiStartX - (i * 55);
        doc.setTextColor(96, 96, 120);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(item.label, x, kpiY + 3, { align: 'right' });
        doc.setTextColor(0, 212, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(item.value, x, kpiY + 10, { align: 'right' });
    });

    // ---- Data Table ----
    const tableHeaders = AppState.headers;
    const tableRows = AppState.filteredData.map(row =>
        tableHeaders.map(h => String(row[h] || ''))
    );

    doc.autoTable({
        head: [tableHeaders],
        body: tableRows,
        startY: kpiY + 20,
        theme: 'grid',
        styles: {
            fontSize: 7,
            cellPadding: 2,
            textColor: [180, 180, 200],
            lineColor: [40, 40, 60],
            lineWidth: 0.2,
            fillColor: [10, 10, 16],
        },
        headStyles: {
            fillColor: [0, 50, 70],
            textColor: [0, 212, 255],
            fontStyle: 'bold',
            fontSize: 7.5,
            halign: 'left',
        },
        alternateRowStyles: {
            fillColor: [15, 15, 24],
        },
        margin: { left: 14, right: 14 },
        didDrawPage: function (data) {
            // Footer on every page
            const pageH = doc.internal.pageSize.getHeight();
            doc.setFontSize(7);
            doc.setTextColor(96, 96, 120);
            doc.text('Yantrixa Analytics — Engineering Intelligence', 14, pageH - 6);
            doc.text(
                `Page ${doc.internal.getCurrentPageInfo().pageNumber}`,
                pageWidth - 14, pageH - 6, { align: 'right' }
            );
        },
    });

    // Save
    const dateStr = new Date().toISOString().slice(0, 10);
    doc.save(`yantrixa-report-${dateStr}.pdf`);
    showToast('success', `Exported ${AppState.filteredData.length} rows as PDF report.`);
}

function exportChartPNG(chartKey) {
    const chart = AppState.charts[chartKey];
    if (!chart) {
        showToast('error', 'Chart not available.');
        return;
    }

    const fileName = 'yantrixa-' + chartKey + '-chart.png';
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = chart.toBase64Image();
    a.download = fileName;
    a.setAttribute('download', fileName);
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); }, 2000);

    showToast('success', chartKey.charAt(0).toUpperCase() + chartKey.slice(1) + ' chart saved as ' + fileName);
}

function copyToClipboard() {
    if (AppState.filteredData.length === 0) {
        showToast('error', 'No data to copy.');
        return;
    }

    const header = AppState.headers.join('\t');
    const rows = AppState.filteredData.map(row =>
        AppState.headers.map(h => row[h]).join('\t')
    );
    const text = [header, ...rows].join('\n');

    navigator.clipboard.writeText(text).then(() => {
        showToast('success', `Copied ${AppState.filteredData.length} rows to clipboard.`);
    }).catch(() => {
        showToast('error', 'Failed to copy. Please try again.');
    });
}

// ============================================
//  UI HELPERS
// ============================================
function showDashboard() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('dashboard-content').classList.remove('hidden');

    // Animate cards
    document.querySelectorAll('.animate-in').forEach((el, i) => {
        el.style.opacity = '0';
        el.style.animationDelay = `${i * 0.08}s`;
        setTimeout(() => { el.style.opacity = ''; }, 10);
    });
}

function clearDashboard() {
    // Destroy all charts to free memory
    ['bar', 'line', 'pie'].forEach(key => {
        if (AppState.charts[key]) {
            AppState.charts[key].destroy();
            AppState.charts[key] = null;
        }
    });

    // Reset all state
    AppState.rawData = [];
    AppState.filteredData = [];
    AppState.headers = [];
    AppState.numericCols = [];
    AppState.dateCols = [];
    AppState.stringCols = [];
    AppState.activeColumn = '';
    AppState.activeCategoryCol = '';
    AppState.activeDateCol = '';
    AppState.filters = { search: '', dateFrom: '', dateTo: '' };

    // Clear filter inputs
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-date-from').value = '';
    document.getElementById('filter-date-to').value = '';
    document.getElementById('filter-column').innerHTML = '';
    document.getElementById('filter-category-col').innerHTML = '';

    // Clear table
    document.getElementById('table-head').innerHTML = '';
    document.getElementById('table-body').innerHTML = '';
    document.getElementById('table-info').textContent = '0 rows';

    // Reset KPI values
    document.getElementById('kpi-total').textContent = '—';
    document.getElementById('kpi-avg').textContent = '—';
    document.getElementById('kpi-max').textContent = '—';
    document.getElementById('kpi-min').textContent = '—';
    document.getElementById('kpi-total-sub').textContent = 'Upload data to view';
    document.getElementById('kpi-avg-sub').textContent = 'Upload data to view';
    document.getElementById('kpi-max-sub').textContent = 'Upload data to view';
    document.getElementById('kpi-min-sub').textContent = 'Upload data to view';

    // Reset file input so same file can be re-uploaded
    document.getElementById('csv-file-input').value = '';

    // Hide dashboard, show empty state
    document.getElementById('dashboard-content').classList.add('hidden');
    document.getElementById('empty-state').style.display = '';

    showToast('info', 'Dashboard cleared. Upload a new file to start fresh.');
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) overlay.classList.add('active');
    else overlay.classList.remove('active');
}

function showToast(type, message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span> ${message}`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}
