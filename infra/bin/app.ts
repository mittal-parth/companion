/** CDK entrypoint: reads the config from the environment and synthesizes every stack. */
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/stacks.js";

buildApp(loadConfig()).synth();
