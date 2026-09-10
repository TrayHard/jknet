import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  HardDrive,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { NewClientDialog } from "../components/NewClientDialog";
import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, EmptyState } from "../components/ui";
import { errorMessage, ipc, type Client, type Settings } from "../lib/ipc";
import { shortenPath } from "../lib/format";
import {
  useClients,
  useDeleteClient,
  useEngines,
  useGameFiles,
  useSettings,
  useUpdateSettings,
} from "../lib/queries";

/**
 * Clients: the only screen of the skeleton that is fully wired to the core.
 *
 * Two blocks, as in the design: the game files card on top, the list of
 * clients below it, and the engine row with New client at the bottom.
 */
export function ClientsPage() {
  const settings = useSettings();
  const clients = useClients();
  const engines = useEngines();
  const gameFiles = useGameFiles();
  const updateSettings = useUpdateSettings();
  const deleteClient = useDeleteClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchSettings = (patch: Partial<Settings>) => {
    if (!settings.data) return;
    setError(null);
    updateSettings.mutate({ ...settings.data, ...patch }, {
      onError: (e) => setError(errorMessage(e)),
    });
  };

  /** Opens the folder picker and saves the folder when it holds the assets. */
  const chooseGameFolder = async () => {
    setError(null);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select the GameData folder",
      });
      if (typeof picked !== "string") return;
      const candidate = await ipc.inspectGameFiles(picked);
      if (!candidate.valid) {
        const missing = candidate.assets
          .filter((asset) => !asset.present)
          .map((asset) => asset.name)
          .join(", ");
        setError(`No game files in ${candidate.path}. Missing: ${missing}.`);
        return;
      }
      patchSettings({ gameDataPath: candidate.path });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // A command that never answered is as much of a failure as one that said
  // no, and outside the Tauri runtime it is the only thing to report.
  const queryError =
    settings.error ?? clients.error ?? engines.error ?? gameFiles.error ?? null;
  const failure = error ?? (queryError ? errorMessage(queryError) : null);

  const configuredPath = settings.data?.gameDataPath ?? null;
  const detected = gameFiles.data ?? [];
  const activeCandidate =
    detected.find((candidate) => candidate.path === configuredPath) ??
    detected.find((candidate) => candidate.valid) ??
    null;

  return (
    <Page>
      <PageHeader
        title="Clients"
        subtitle="A client is an engine build with its own files and settings. Name it and it is yours."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => setDialogOpen(true)}
          >
            New client
          </Button>
        }
      />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      {/* Game files ------------------------------------------------------ */}
      <section className="rounded-lg border border-line bg-surface p-16 mb-24">
        <div className="flex items-start gap-12">
          <span className="flex items-center justify-center size-36 rounded-md bg-elevated text-fg-secondary shrink-0">
            <HardDrive size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-8">
              <h2 className="text-heading-sm text-fg">Game files</h2>
              {configuredPath ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  Ready
                </Badge>
              ) : (
                <Badge tone="warm">Not set</Badge>
              )}
            </div>
            <p className="text-body-sm text-fg-secondary pt-4">
              JKNet reads <span className="text-mono-sm">assets0.pk3</span>–
              <span className="text-mono-sm">assets3.pk3</span> from this folder
              and never writes into it.
            </p>
            <p className="text-mono-sm text-fg-accent pt-8 break-all">
              {configuredPath ??
                activeCandidate?.path ??
                (gameFiles.isLoading ? "Looking for Steam and GOG copies…" : "No copy found")}
            </p>
            {activeCandidate && !configuredPath ? (
              <p className="text-body-sm text-fg-muted pt-4">
                Found through {sourceName(activeCandidate.source)}. Confirm it to
                start using it.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-8 shrink-0">
            <Button icon={<FolderOpen size={16} />} onClick={() => void chooseGameFolder()}>
              Change folder
            </Button>
            {activeCandidate && activeCandidate.path !== configuredPath ? (
              <Button
                variant="primary"
                onClick={() => patchSettings({ gameDataPath: activeCandidate.path })}
              >
                Use this folder
              </Button>
            ) : null}
          </div>
        </div>

        {detected.length > 1 ? (
          <ul className="flex flex-col gap-4 pt-16">
            {detected.map((candidate) => (
              <li
                key={candidate.path}
                className="flex items-center gap-8 text-body-sm text-fg-muted"
              >
                <Badge tone={candidate.valid ? "neutral" : "danger"}>
                  {sourceName(candidate.source)}
                </Badge>
                <span className="text-mono-xs truncate" title={candidate.path}>
                  {shortenPath(candidate.path, 64)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* Clients --------------------------------------------------------- */}
      <section className="flex flex-col gap-12">
        <h2 className="text-label-xs text-fg-muted">Your clients</h2>

        {clients.isLoading ? (
          <p className="text-body-sm text-fg-muted">Loading…</p>
        ) : clients.data && clients.data.length > 0 ? (
          <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
            {clients.data.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                engineName={
                  engines.data?.find((engine) => engine.id === client.engineId)?.name ??
                  client.engineId
                }
                isDefault={client.id === settings.data?.defaultClientId}
                onMakeDefault={() => patchSettings({ defaultClientId: client.id })}
                onDelete={() =>
                  deleteClient.mutate(client.id, {
                    onError: (e) => setError(errorMessage(e)),
                  })
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Plus size={24} />}
            title="No clients yet"
            text="A client is a named engine build with its own mods and settings. Create one and it shows up here."
            action={
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                New client
              </Button>
            }
          />
        )}
      </section>

      {/* Engines --------------------------------------------------------- */}
      <section className="flex flex-col gap-12 pt-24">
        <h2 className="text-label-xs text-fg-muted">Engines</h2>
        <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
          {(engines.data ?? []).map((engine) => (
            <li
              key={engine.id}
              className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-16"
            >
              <div className="flex items-center gap-8">
                <span className="text-heading-sm text-fg">{engine.name}</span>
                {engine.recommended ? <Badge tone="accent">Recommended</Badge> : null}
              </div>
              <p className="text-body-sm text-fg-secondary">{engine.description}</p>
              <p className="text-mono-xs text-fg-muted">{engine.repo}</p>
            </li>
          ))}
        </ul>
      </section>

      {dialogOpen ? (
        <NewClientDialog
          onClose={() => setDialogOpen(false)}
          onError={(message) => setError(message)}
        />
      ) : null}
    </Page>
  );
}

interface ClientCardProps {
  client: Client;
  engineName: string;
  isDefault: boolean;
  onMakeDefault: () => void;
  onDelete: () => void;
}

function ClientCard({
  client,
  engineName,
  isDefault,
  onMakeDefault,
  onDelete,
}: ClientCardProps) {
  return (
    <li className="flex items-start gap-12 rounded-lg border border-line bg-surface p-16">
      <span className="flex items-center justify-center size-44 rounded-md bg-elevated text-fg-accent text-display-md shrink-0">
        {engineName.slice(0, 2).toUpperCase()}
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="flex items-center gap-8">
          <span className="text-heading-sm text-fg truncate">{client.name}</span>
          {isDefault ? <Badge tone="accent">Default</Badge> : null}
        </div>
        <div className="flex items-center gap-8">
          <Badge tone="neutral">
            {engineName}
            {client.engineVersion ? ` ${client.engineVersion}` : ""}
          </Badge>
          {client.engineVersion ? null : (
            <span className="text-body-sm text-fg-muted">Engine not installed</span>
          )}
        </div>
        <span className="text-mono-xs text-fg-muted">
          {client.id} · created {client.createdAt.slice(0, 10)}
        </span>
      </div>
      <div className="flex flex-col gap-8 shrink-0">
        <Button size="sm" onClick={onMakeDefault} disabled={isDefault}>
          {isDefault ? "Default" : "Make default"}
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={onDelete}>
          Delete
        </Button>
      </div>
    </li>
  );
}

/** Human name of a detection source, for the game files card. */
function sourceName(source: string): string {
  switch (source) {
    case "steam":
      return "Steam";
    case "gog":
      return "GOG";
    case "manual":
      return "Chosen by hand";
    default:
      return "Saved";
  }
}
