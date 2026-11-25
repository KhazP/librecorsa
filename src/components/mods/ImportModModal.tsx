"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { tabStops, useFocusNav } from "@/components/menu/useFocusNav";
import { Button, ConfirmDialog, EmptyState, IconButton, Meter, Skeleton, Tabs, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import type { CarDefinition, CarId } from "@/lib/cars/car-registry";
import { unregisterCustomCarMod } from "@/lib/mods/dynamic-vehicle";
import { isCspProtectedKn5Blob } from "@/lib/mods/kn5-protection";
import { importAssettoCorsaMod, type ModImportProgress } from "@/lib/mods/mod-extractor";
import { deleteCustomCar, getAllCustomCars, type CustomCarRecord } from "@/lib/mods/mod-store";
import { saveCarChoice } from "@/lib/settings/player-settings";
import { readModDrop, type ModDrop } from "./read-mod-drop";

export interface ImportModModalProps {
  open: boolean;
  onClose: () => void;
  selectedCarId: CarId;
  onSelectCar?: (carId: CarId) => void;
}

type ModTab = "import" | "installed";
type InstalledCar = { car: CustomCarRecord; protectedModel: boolean };
type ImportState =
  | { state: "idle" }
  | { state: "processing"; name: string; progress: ModImportProgress }
  | { state: "success"; car: CarDefinition }
  | { state: "error"; message: string };

const DIRECTORY_PICKER = { webkitdirectory: "" };

function liveryCount(count: number | undefined): string {
  return count === 1 ? "1 livery" : `${count ?? 0} liveries`;
}

function clearDeletedCarLink(carId: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("car") !== carId) return;

  url.searchParams.delete("car");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function ModPreview({ url }: { url?: string }) {
  return (
    <span className="relative grid h-13 w-20 shrink-0 place-items-center overflow-hidden rounded-lc-nub bg-lc-titanium text-lc-slate">
      <Icon name="car" size="lg" />
      {url ? (
        // This is a Blob URL from the local archive. The car name is immediately alongside it.
        <img
          key={url}
          src={url}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      ) : null}
    </span>
  );
}

function ModSummary({ title, meta, preview }: { title: string; meta?: string; preview?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <ModPreview url={preview} />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="lc-row-label m-0">{title}</p>
        {meta ? <p className="lc-hint m-0 mt-1">{meta}</p> : null}
      </div>
    </div>
  );
}

function InstalledMod({
  car, protectedModel, onSelect, onRemove,
}: InstalledCar & {
  onSelect?: () => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string>();
  const image = car.previewBlob ?? car.thumbBlob ?? car.badgeBlob;
  useEffect(() => {
    if (!image) return;
    const preview = URL.createObjectURL(image);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [image]);

  return (
    <li className="grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <ModSummary
        title={car.title}
        meta={protectedModel ? "Modelo protegido por CSP. Vuelve a importar el paquete original completo." : liveryCount(car.skins?.length)}
        preview={image ? url : undefined}
      />
      <div className="flex items-center justify-end gap-1.5">
        {onSelect && !protectedModel ? (
          <Button variant="secondary" size="sm" onClick={onSelect} aria-label={`Elegir coche: ${car.title}`}>
            Elegir coche
          </Button>
        ) : null}
        <IconButton
          icon={<Icon name="delete" />}
          aria-label={`Eliminar ${car.title}`}
          title="Eliminar mod"
          size="sm"
          onClick={onRemove}
        />
      </div>
    </li>
  );
}

function ImportNotice({ error, title, children }: { error?: boolean; title: string; children?: ReactNode }) {
  return (
    <Well role={error ? "alert" : "status"} className="flex items-start gap-3 p-3.5">
      <Icon name={error ? "error" : "success"} size="md" className={error ? "text-lc-loss-ink" : "text-lc-gain"} />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="lc-row-label m-0">{title}</p>
        {children ? <p className="lc-body m-0 mt-1">{children}</p> : null}
      </div>
    </Well>
  );
}

export function ImportModModal({ open, onClose, selectedCarId, onSelectCar }: ImportModModalProps) {
  const [tab, setTab] = useState<ModTab>("import");
  const [flow, setFlow] = useState<ImportState>({ state: "idle" });
  const [cars, setCars] = useState<InstalledCar[]>([]);
  const [libraryState, setLibraryState] = useState<"loading" | "ready" | "error">("loading");
  const [deleteTarget, setDeleteTarget] = useState<CustomCarRecord>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const archiveRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const dragDepth = useRef(0);
  const titleId = useId();
  const descriptionId = useId();
  const panelId = useId();
  const busy = flow.state === "processing";
  const navigation = useRef({ busy, confirm: Boolean(deleteTarget), onClose });
  navigation.current = { busy, confirm: Boolean(deleteTarget), onClose };

  const loadInstalled = useCallback(async () => {
    setLibraryState("loading");
    try {
      const list = await getAllCustomCars();
      const inspected = await Promise.all(list.sort((a, b) => b.importedAt - a.importedAt).map(async (car) => ({
        car,
        protectedModel: await isCspProtectedKn5Blob(car.kn5Blob),
      })));
      setCars(inspected);
      setLibraryState("ready");
    } catch {
      setLibraryState("error");
    }
  }, []);

  const dismiss = () => {
    if (!importing.current) onClose();
  };

  const switchTab = () => {
    if (!importing.current) setTab((value) => value === "import" ? "installed" : "import");
  };

  useFocusNav(modalRef, {
    enabled: open,
    autoFocus: false,
    keyboardBack: false,
    onBack: dismiss,
    onPrevTab: switchTab,
    onNextTab: switchTab,
  });

  useEffect(() => {
    if (!open) return;
    void loadInstalled();
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKey = (event: KeyboardEvent) => {
      if (navigation.current.confirm) return; // ConfirmDialog owns Tab and Esc while it is on top.
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!navigation.current.busy && !importing.current) navigation.current.onClose();
      } else if (event.key === "Tab" && modalRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const controls = tabStops(modalRef.current);
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (current <= 0 ? controls.length - 1 : current - 1) : (current + 1) % controls.length;
        controls[next]?.focus();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, loadInstalled]);

  useEffect(() => {
    const root = modalRef.current;
    if (!open || !root || deleteTarget) return;
    const focused = document.activeElement;
    if (!busy && focused && root.contains(focused) && !focused.matches(":disabled, [inert] *")) return;
    const next = root.querySelector<HTMLElement>("[data-mod-focus]") ?? tabStops(root)[0];
    next?.focus({ preventScroll: true });
  }, [open, tab, flow.state, busy, deleteTarget, libraryState]);

  async function startImport(resolveInput: () => ModDrop | Promise<ModDrop>, name: string) {
    if (importing.current) return;
    importing.current = true;
    setTab("import");
    setFlow({ state: "processing", name, progress: { stage: "reading", message: "Leyendo archivos", percent: 0 } });
    let fromArchive = false;
    try {
      const input = await resolveInput();
      fromArchive = input instanceof File;
      const label = input instanceof File ? input.name : name;
      const car = await importAssettoCorsaMod(input, (progress) => setFlow({ state: "processing", name: label, progress }));
      setFlow({ state: "success", car });
      void loadInstalled();
    } catch (error) {
      const memoryError = error instanceof Error && /array buffer allocation failed|out of memory|\boom\b|no se pudo reservar memoria/i.test(error.message);
      const message = error instanceof DOMException && error.name === "QuotaExceededError"
        ? "No hay espacio suficiente en el navegador. Prueba en una ventana normal si estás en modo privado, o elimina algún mod instalado."
        : memoryError
          ? fromArchive
            ? "El navegador se quedó sin memoria al importar. Descomprime el archivo e importa la carpeta del coche. No necesitas borrar el mod instalado."
            : "El navegador se quedó sin memoria al importar. Si estás usando ese coche, cambia a otro antes de volver a intentarlo."
        : error instanceof Error ? error.message : "No se pudo leer el mod. Prueba a elegir el archivo de nuevo.";
      setFlow({ state: "error", message });
    } finally {
      importing.current = false;
    }
  }

  function chooseCar(id: string) {
    onSelectCar?.(id as CarId);
    onClose();
  }

  async function removeMod() {
    if (!deleteTarget || deleting) return;
    const selectDefaultCar = selectedCarId === deleteTarget.id;
    setDeleting(true);
    setDeleteError(false);
    try {
      await deleteCustomCar(deleteTarget.id);
      if (selectDefaultCar) {
        saveCarChoice("lc26");
        clearDeletedCarLink(deleteTarget.id);
      }
      unregisterCustomCarMod(deleteTarget.id);
      if (selectDefaultCar) onSelectCar?.("lc26");
      setCars((list) => list.filter(({ car }) => car.id !== deleteTarget.id));
      if (flow.state === "success" && flow.car.id === deleteTarget.id) setFlow({ state: "idle" });
    } catch {
      setDeleteError(true);
    } finally {
      setDeleting(false);
      setDeleteTarget(undefined);
    }
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-(--z-lc-notice) flex items-center justify-center bg-lc-void/70 backdrop-blur-[6px] pt-[max(.75rem,env(safe-area-inset-top))] pr-[max(.75rem,env(safe-area-inset-right))] pb-[max(.75rem,env(safe-area-inset-bottom))] pl-[max(.75rem,env(safe-area-inset-left))]"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) dismiss();
        }}
      >
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="lc-glass lc-ui-zoom flex max-h-full w-full max-w-[36rem] flex-col overflow-hidden rounded-lc-sheet bg-lc-carbon/95 text-lc-chalk shadow-lc-sheet [backdrop-filter:none]"
          inert={Boolean(deleteTarget)}
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-lc-line px-5 py-3.5 sm:px-6 sm:py-4 short:py-2">
            <div className="min-w-0">
              <h2 id={titleId} className="lc-h2 m-0">Importar mods</h2>
              <p id={descriptionId} className="lc-hint m-0 mt-1">Coches de Assetto Corsa</p>
            </div>
            <IconButton
              icon={<Icon name="close" />}
              aria-label="Cerrar importador"
              title={busy ? "Espera a que termine la importación" : "Cerrar importador"}
              disabled={busy}
              onClick={dismiss}
            />
          </header>

          <div className="shrink-0 px-4 pt-4 sm:px-6 short:pt-2" inert={busy}>
            <Tabs<ModTab>
              aria-label="Mods"
              panelId={panelId}
              navZone="mod-tabs"
              fill
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "import", label: "Importar" },
                { id: "installed", label: "Instalados", badge: libraryState === "ready" && cars.length ? <Badge size="sm">{cars.length}</Badge> : undefined },
              ]}
            />
          </div>

          <div id={panelId} role="tabpanel" aria-label={tab === "import" ? "Importar" : "Instalados"} className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:pb-6 short:py-2">
            {tab === "import" ? (
              <>
                <input ref={archiveRef} type="file" aria-label="Archivo del mod" accept=".zip,.rar,.7z" hidden onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void startImport(() => file, file.name);
                }} />
                <input ref={folderRef} type="file" aria-label="Carpeta del coche" {...DIRECTORY_PICKER} multiple hidden onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length) void startImport(() => files, files[0].webkitRelativePath.split("/")[0] || "Carpeta del coche");
                }} />

                {flow.state === "idle" ? (
                  <>
                    <Well
                      className={cx("border-dashed px-3.5 py-4 transition-colors duration-200 motion-reduce:transition-none sm:p-5 short:py-2.5", dragging ? "border-lc-volt bg-lc-titanium" : "border-lc-keyline")}
                      onDragEnter={(event) => {
                        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                        event.preventDefault();
                        dragDepth.current++;
                        setDragging(true);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                      }}
                      onDragLeave={() => {
                        dragDepth.current = Math.max(0, dragDepth.current - 1);
                        if (!dragDepth.current) setDragging(false);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        dragDepth.current = 0;
                        setDragging(false);
                        const transfer = event.dataTransfer;
                        void startImport(() => readModDrop(transfer), "Archivos arrastrados");
                      }}
                    >
                      <div className="flex items-center gap-3.5">
                        <span className="grid size-12 shrink-0 place-items-center rounded-lc-row bg-lc-titanium text-lc-fog">
                          <Icon name="add" size="lg" />
                        </span>
                        <div className="min-w-0">
                          <p className="lc-row-label m-0">{dragging ? "Suelta aquí para importar" : "Arrastra el archivo o la carpeta"}</p>
                          <p className="lc-hint m-0 mt-1">ZIP, RAR, 7Z o la carpeta del coche con su modelo KN5.</p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2 short:mt-2">
                        <Button variant="primary" data-mod-focus="" onClick={() => archiveRef.current?.click()}>Elegir archivo</Button>
                        <Button variant="secondary" onClick={() => folderRef.current?.click()}>Elegir carpeta</Button>
                      </div>
                    </Well>
                    <p className="lc-hint m-0 mt-3 flex items-center gap-2 short:mt-2">
                      <Icon name="privacy" />
                      Los archivos se procesan y se guardan en este navegador.
                    </p>
                  </>
                ) : flow.state === "processing" ? (
                  <Well className="space-y-3 p-4" tabIndex={-1} data-mod-focus="" aria-label="Importando el mod">
                    <p className="lc-row-label m-0 [overflow-wrap:anywhere]">{flow.name}</p>
                    <div role="progressbar" aria-label="Progreso de importación" aria-valuemin={0} aria-valuemax={100} aria-valuenow={flow.progress.percent}>
                      <div aria-hidden="true">
                        <Meter label={flow.progress.message} value={flow.progress.percent / 100} stacked tone="info" />
                      </div>
                    </div>
                    <p className="lc-hint m-0" role="status">Espera a que termine antes de cerrar el importador.</p>
                  </Well>
                ) : flow.state === "success" ? (
                  <div className="flex flex-col gap-3.5">
                    <ImportNotice title="Mod importado">Ya está disponible en el selector de coches.</ImportNotice>
                    <ModSummary title={flow.car.title} meta={liveryCount(flow.car.skins?.length)} preview={flow.car.thumbUrl} />
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="secondary" data-mod-focus={onSelectCar ? undefined : ""} onClick={() => setFlow({ state: "idle" })}>
                        Importar otro
                      </Button>
                      {onSelectCar ? (
                        <Button variant="primary" data-mod-focus="" onClick={() => chooseCar(flow.car.id)}>Elegir coche</Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3.5">
                    <ImportNotice error title="No se pudo importar">{flow.message}</ImportNotice>
                    <Button className="self-end" data-mod-focus="" onClick={() => setFlow({ state: "idle" })}>Volver a importar</Button>
                  </div>
                )}
              </>
            ) : (
              <>
                {deleteError ? <ImportNotice error title="No se pudo eliminar">El mod sigue instalado. Vuelve a intentarlo.</ImportNotice> : null}
                {libraryState === "loading" ? (
                  <div aria-busy="true" aria-label="Cargando mods instalados" role="status" className="flex items-center gap-3 p-2">
                    <Skeleton className="h-13 w-20" />
                    <Skeleton shape="line" className="w-36" />
                  </div>
                ) : libraryState === "error" ? (
                  <div className="flex flex-col gap-3">
                    <ImportNotice error title="No se pudo abrir la biblioteca">Comprueba que este navegador permita el almacenamiento local.</ImportNotice>
                    <Button className="self-end" onClick={() => void loadInstalled()}>Reintentar</Button>
                  </div>
                ) : cars.length ? (
                  <ul className="m-0 list-none divide-y divide-lc-line p-0" aria-label="Coches instalados">
                    {cars.map(({ car, protectedModel }) => (
                      <InstalledMod
                        key={car.id}
                        car={car}
                        protectedModel={protectedModel}
                        onSelect={onSelectCar ? () => chooseCar(car.id) : undefined}
                        onRemove={() => setDeleteTarget(car)}
                      />
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    icon={<Icon name="car" />}
                    action={<Button variant="primary" onClick={() => setTab("import")}>Importar un mod</Button>}
                  >
                    Aún no has importado ningún coche.
                  </EmptyState>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="¿Eliminar este mod?"
        confirmLabel="Eliminar mod"
        cancelLabel="Cancelar"
        icon={<Icon name="delete" />}
        busy={deleting}
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={() => void removeMod()}
      >
        {deleteTarget?.title} se eliminará de este navegador. El archivo original no se modifica.
      </ConfirmDialog>
    </>,
    document.body,
  );
}
