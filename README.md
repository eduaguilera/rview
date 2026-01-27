# Rview

A Positron/VS Code extension for R developers with three main features:

1. **Tibble Explorer** — Hover on tibble/data.frame names to open them in the Data Explorer or Simple Data Viewer
2. **Simple Data Viewer** — Lightweight RStudio-style data viewer with column filters
3. **Code Section Folding** — RStudio-style collapsible code sections using `# Section ----` markers

## Features

### 1. Tibble Explorer (Hover to View Data)

Quickly inspect your data frames without leaving your code:

- **Hover** over any tibble/data.frame variable to see a quick action link to open it in the Data Explorer
- **Smart Detection** — automatically recognizes variables created with common patterns
- **Pipe Chain Support** — works with tidyverse pipes (`%>%` and `|>`)

#### Example

```r
my_data <- tibble(
  x = 1:10,
  y = rnorm(10)
)

# Hover on 'my_data' anywhere to view it in Data Explorer
my_data %>%
  filter(x > 5)
```

#### Recognized Patterns

The extension detects tibbles/data.frames created with:

| Category | Functions |
|----------|-----------|
| **Creation** | `tibble()`, `tribble()`, `data.frame()`, `as_tibble()`, `as.data.frame()` |
| **Import** | `read_csv()`, `read_tsv()`, `read_excel()`, `read.csv()`, `fread()` |
| **Transform** | `mutate()`, `select()`, `filter()`, `summarize()`, `*_join()`, `pivot_*()` |

---

### 2. Simple Data Viewer (with Column Filters)

A lightweight data viewer inspired by RStudio's `View()` function, with filter inputs on each column.

#### Features

- **Column Filters** — Type in the filter box above any column to filter rows
- **Lightweight** — Simple HTML table, fast and responsive
- **1000 Row Preview** — Shows first 1000 rows for large datasets
- **Copy/Paste Workflow** — Works via clipboard for maximum compatibility

#### How to Use

1. Place cursor on a data frame variable
2. Press `Ctrl+Shift+V` or run command **"Rview: Open in Simple Data Viewer"**
3. The data loads automatically from your R session

#### Sorting

- Click column headers to sort (ascending → descending → remove)
- Multi-level sorting: Click additional columns while holding sort to add secondary/tertiary sorts
- Sort indicators show the sort order (1↑, 2↓, etc.)

#### Resizing Columns

- Drag the border between column headers to resize

#### Screenshot

```
┌────────────────────────────────────────────────────────┐
│ 📊 my_data                          100 rows × 5 cols  │
├────────────────────────────────────────────────────────┤
│ [Filter...] │ [Filter...] │ [Filter...] │ [Filter...]  │
├─────────────┼─────────────┼─────────────┼──────────────┤
│ name        │ age         │ city        │ score        │
├─────────────┼─────────────┼─────────────┼──────────────┤
│ Alice       │ 25          │ New York    │ 95           │
│ Bob         │ 30          │ Boston      │ 87           │
│ ...         │ ...         │ ...         │ ...          │
└────────────────────────────────────────────────────────┘
```

---

### 3. Code Section Folding (RStudio-style)

Organize long R scripts with collapsible sections, just like in RStudio.

#### Setup in Positron

To enable RStudio-style folding, configure Positron to use this extension as the folding provider:

1. Open Settings (`Ctrl+,`)
2. Search for `folding strategy`
3. Set **Rview** as the `Default Folding Range Provider`

Or add this to your `settings.json`:
```json
"editor.foldingStrategy": "auto"
```

#### Section Markers

Create a foldable section by ending a comment line with **4 or more dashes**:

```r
# Load Data ----
data <- read_csv("file.csv")
data2 <- read_excel("file.xlsx")

# Clean Data ----
data <- data %>%
  filter(!is.na(value)) %>%
  mutate(new_col = value * 2)

# Analysis ----
model <- lm(y ~ x, data = data)
summary(model)
```

Or by starting a comment with **4 or more hash marks**:

```r
#### Load Data ####
data <- read_csv("file.csv")

#### Clean Data ####
data <- data %>%
  filter(!is.na(value))
```

#### How to Use

- Click the **fold icon** in the gutter (left margin) next to section headers
- Or use keyboard shortcuts:
  - `Ctrl+Shift+[` — Fold section
  - `Ctrl+Shift+]` — Unfold section

---

## Requirements

- **Positron IDE** (recommended) or VS Code with R extension
- R language support enabled

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `rview.openInDataExplorer` | `Ctrl+Shift+D` | Open in Positron Data Explorer |
| `rview.openSimpleViewer` | `Ctrl+Shift+V` | Open in Simple Data Viewer |

## Known Issues

- Tibble detection uses heuristics and may not catch all data frame variables
- The variable must exist in the R session memory for Data Explorer to work

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host for testing.

## License

MIT
