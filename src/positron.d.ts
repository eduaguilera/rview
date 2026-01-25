// Type declarations for the Positron API
// Based on https://github.com/posit-dev/positron/tree/main/extensions/positron-r/src/

declare module 'positron' {
    export namespace runtime {
        /**
         * Execute code in a language runtime.
         * @param languageId The language ID (e.g., 'r', 'python')
         * @param code The code to execute
         * @param focus Whether to focus the console after execution
         * @param allowIncomplete Whether incomplete code is allowed
         * @param mode Optional execution mode
         */
        function executeCode(
            languageId: string,
            code: string,
            focus: boolean,
            allowIncomplete: boolean,
            mode?: RuntimeCodeExecutionMode
        ): Promise<void>;
    }

    export enum RuntimeCodeExecutionMode {
        Interactive = 'interactive',
        NonInteractive = 'noninteractive',
        Silent = 'silent'
    }
}
