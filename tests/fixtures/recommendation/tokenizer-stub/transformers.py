"""Offline tokenizer double for exercising the CLI without a model installation."""
import json
import re
from pathlib import Path

__version__ = "fixture"


class AutoTokenizer:
    @classmethod
    def from_pretrained(cls, directory, local_files_only):
        assert local_files_only
        tokenizer = cls()
        tokenizer.vocab = json.loads((Path(directory) / "vocab.json").read_bytes())
        return tokenizer

    def get_vocab(self):
        return self.vocab

    def encode(self, text, add_special_tokens):
        assert not add_special_tokens
        return re.findall(r"<[^>]+>|.", text, flags=re.DOTALL)

    def save_pretrained(self, directory):
        (Path(directory) / "vocab.json").write_text(json.dumps(self.vocab, sort_keys=True), encoding="utf-8")
