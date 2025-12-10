export interface NewOptions {
    template: string;
    install?: boolean;
    git?: boolean;
}
/**
 * Create a new ZapRS project
 */
export declare function newCommand(name: string, options: NewOptions): Promise<void>;
//# sourceMappingURL=new.d.ts.map