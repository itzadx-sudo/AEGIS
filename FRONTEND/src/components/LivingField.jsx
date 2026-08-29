import { useEffect, useRef } from "react";
import { initLivingField, destroyLivingField } from "@/lib/livingField";

// the two fixed canvases, at the app root so the glass panels sample them
export function LivingField() {
  const gridRef = useRef(null);
  const fieldRef = useRef(null);
  useEffect(() => {
    initLivingField(gridRef.current, fieldRef.current);
    return () => destroyLivingField();
  }, []);
  return (
    <>
      <canvas ref={gridRef} className="living-grid" aria-hidden="true" />
      <canvas ref={fieldRef} className="living-field" aria-hidden="true" />
    </>
  );
}
