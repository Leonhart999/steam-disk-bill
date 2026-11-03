export {};

declare global {
    const backend: {
        scan_disk(coldDays: number): Promise<string>;
    };
}
