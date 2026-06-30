import { useState } from "react";
import { Navbar } from "@/components/Navbar";
import { UploadPage } from "@/pages/UploadPage";
import { AnalysisPage } from "@/pages/AnalysisPage";
import { ResultsPage } from "@/pages/ResultsPage";

const PAGES = {
  upload: UploadPage,
  analysis: AnalysisPage,
  results: ResultsPage,
};

export default function App() {
  const [page, setPage] = useState("upload");
  const ActivePage = PAGES[page] ?? UploadPage;

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar active={page} navigate={setPage} />
      <ActivePage navigate={setPage} />
    </div>
  );
}
