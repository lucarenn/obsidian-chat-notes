import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Obsidian augments the DOM globals; these are the ones this plugin uses
				createDiv: "readonly",
				createEl: "readonly",
				createSpan: "readonly",
				createFragment: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		/* The settings descriptions name the YAML keys they can be overridden with, and those
		   keys really are camelCase - the sentence-case rule reads them as Title Case prose.
		   Listed explicitly rather than switching the rule off, so it still checks the text
		   around them. */
		plugins: { obsidianmd },
		rules: {
			"obsidianmd/ui/sentence-case": ["error", {
				ignoreWords: [
					"msgColor", "msgPinColor", "msgFlashColor", "msgReplyColor",
					"msgBorderColor", "msgCornerRadius", "msgShowAuthor", "msgShowTime",
					"msgAuthorBadges", "msgButtonShadow", "msgScrollOnSend",
					"msgDefaultAuthor",
				],
			}],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
