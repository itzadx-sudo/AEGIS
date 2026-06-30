# Aegis — IT Risk Assessment

Vendor IT-risk assessment UI, built on **React + Vite + Tailwind CSS + shadcn/ui**.

## Stack

- **React** — component architecture (`src/components`, `src/pages`)
- **Vite** — build toolchain (`vite.config.js`, `@` → `src` alias)
- **Tailwind CSS** — utility-based styling; the Aegis palette/fonts/radii live as
  CSS variables in `src/index.css` and are exposed as Tailwind tokens in
  `tailwind.config.js`
- **shadcn/ui** — accessible primitives in `src/components/ui` (Button, Card,
  Textarea, Input, Badge, Avatar, Progress, DropdownMenu), themed to the design

## Getting started

```bash
npm install
npm run dev      # start the dev server
npm run build    # production build
npm run preview  # preview the production build
```

## Structure

```
src/
  components/
    ui/              shadcn/ui primitives (themed)
    Navbar.jsx       top navigation + page switching
    UserMenu.jsx     avatar dropdown with past sessions
    PageHeader.jsx   shared page title / shell
  pages/
    UploadPage.jsx   document upload + processing list
    AnalysisPage.jsx system-led gap-analysis Q&A (stateful)
    ResultsPage.jsx  filterable / searchable risk list
    ReportPage.jsx   report preview + downloads
  data/risks.js      risk findings, questions, sessions, severity tallies
  App.jsx            shell + page routing state
```

The original static mockup is preserved at `design.html` for reference.
