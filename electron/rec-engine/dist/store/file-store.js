import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export class FileStore {
    dataDir;
    eventsPath;
    itemsPath;
    onboardingPath;
    constructor(dataDir) {
        this.dataDir = dataDir;
        mkdirSync(dataDir, { recursive: true });
        this.eventsPath = join(dataDir, 'events.jsonl');
        this.itemsPath = join(dataDir, 'items.json');
        this.onboardingPath = join(dataDir, 'onboarding.json');
    }

    loadEvents() {
        if (!existsSync(this.eventsPath))
            return [];
        const text = readFileSync(this.eventsPath, 'utf8');
        const events = [];
        for (const line of text.split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            try {
                events.push(JSON.parse(s));
            }
            catch {

            }
        }
        return events;
    }
    appendEvents(events) {
        if (events.length === 0)
            return;
        const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(this.eventsPath, lines, 'utf8');
    }
    loadItems() {
        if (!existsSync(this.itemsPath))
            return [];
        const raw = JSON.parse(readFileSync(this.itemsPath, 'utf8'));
        return raw.items ?? [];
    }
    saveItems(items) {
        writeFileSync(this.itemsPath, JSON.stringify({ items }, null, 0), 'utf8');
    }
    loadOnboarding() {
        if (!existsSync(this.onboardingPath))
            return new Map();
        const raw = JSON.parse(readFileSync(this.onboardingPath, 'utf8'));
        return new Map(Object.entries(raw));
    }
    saveOnboarding(map) {
        writeFileSync(this.onboardingPath, JSON.stringify(Object.fromEntries(map)), 'utf8');
    }

    artifactPath(name) {
        return join(this.dataDir, 'artifacts', name);
    }
    ensureArtifactDir() {
        const dir = join(this.dataDir, 'artifacts');
        mkdirSync(dir, { recursive: true });
        return dir;
    }
}
