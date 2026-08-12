#!/usr/bin/env node
import fs from 'fs';
import { validateDiscoveryDeclaration } from './validation.js';

const file = process.argv[2];
if (!file) {
    console.error("Usage: validate-discovery <path-to-json>");
    process.exit(1);
}

try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errors = validateDiscoveryDeclaration(data);
    if (errors.length > 0) {
        console.error("Validation failed:");
        errors.forEach(err => console.error(" - " + err));
        process.exit(1);
    }
    console.log("Validation passed.");
} catch (err) {
    console.error("Error reading or parsing file:", err.message);
    process.exit(1);
}
