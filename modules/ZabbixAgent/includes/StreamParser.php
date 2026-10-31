<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Includes;

use RuntimeException;

/**
 * Normalizes the server-sent events of a provider.
 */
class StreamParser {

	private string $type;
	private $emit;
	private string $buffer = '';
	private string $text = '';
	private string $reasoning = '';
	private array $calls = [];
	private array $thinking = [];
	private array $usage = ['input' => 0, 'output' => 0];
	private string $stop = '';

	public function __construct(string $type, callable $emit) {
		$this->type = $type;
		$this->emit = $emit;
	}

	public function feed(string $chunk): void {
		$this->buffer .= $chunk;

		while (($end = strpos($this->buffer, "\n")) !== false) {
			$line = rtrim(substr($this->buffer, 0, $end), "\r");
			$this->buffer = substr($this->buffer, $end + 1);

			if (strncmp($line, 'data:', 5) !== 0) {
				continue;
			}

			$data = trim(substr($line, 5));

			if ($data === '' || $data === '[DONE]') {
				continue;
			}

			$event = json_decode($data, true);

			if (!is_array($event)) {
				continue;
			}

			$this->type === Llm::TYPE_ANTHROPIC ? $this->anthropic($event) : $this->openAi($event);
		}
	}

	public function finish(): array {
		$tool_calls = [];

		foreach ($this->calls as $call) {
			$arguments = json_decode($call['json'] === '' ? '{}' : $call['json'], true);

			$tool_calls[] = [
				'id' => $call['id'],
				'name' => $call['name'],
				'arguments' => is_array($arguments) ? $arguments : []
			];
		}

		$message = ['role' => 'assistant', 'content' => $this->text];

		if ($tool_calls) {
			$message['tool_calls'] = $tool_calls;
		}

		if ($this->reasoning !== '') {
			$message['reasoning'] = $this->reasoning;
		}

		if ($this->thinking) {
			$message['thinking'] = array_values($this->thinking);
		}

		return ['message' => $message, 'usage' => $this->usage, 'stop' => $this->stop];
	}

	private function openAi(array $event): void {
		if (isset($event['error'])) {
			throw new RuntimeException((string) ($event['error']['message'] ?? 'Provider error'));
		}

		if (isset($event['usage']['prompt_tokens'])) {
			$this->usage = [
				'input' => (int) $event['usage']['prompt_tokens'],
				'output' => (int) ($event['usage']['completion_tokens'] ?? 0)
			];
		}

		$choice = $event['choices'][0] ?? null;

		if ($choice === null) {
			return;
		}

		$delta = $choice['delta'] ?? [];

		if (($delta['reasoning_content'] ?? '') !== '') {
			$this->reasoning .= $delta['reasoning_content'];
			($this->emit)('reasoning', $delta['reasoning_content']);
		}

		if (($delta['content'] ?? '') !== '') {
			$this->text .= $delta['content'];
			($this->emit)('text', $delta['content']);
		}

		foreach ($delta['tool_calls'] ?? [] as $call) {
			$index = $call['index'] ?? 0;
			$this->calls[$index] = $this->calls[$index] ?? ['id' => '', 'name' => '', 'json' => ''];

			if (($call['id'] ?? '') !== '') {
				$this->calls[$index]['id'] = $call['id'];
			}

			if (($call['function']['name'] ?? '') !== '') {
				$this->calls[$index]['name'] .= $call['function']['name'];
			}

			$this->calls[$index]['json'] .= $call['function']['arguments'] ?? '';
		}

		if (($choice['finish_reason'] ?? null) !== null) {
			$this->stop = (string) $choice['finish_reason'];
		}
	}

	private function anthropic(array $event): void {
		switch ($event['type'] ?? '') {
			case 'message_start':
				$this->usage['input'] = (int) ($event['message']['usage']['input_tokens'] ?? 0);
				break;

			case 'content_block_start':
				$block = $event['content_block'] ?? [];
				$index = $event['index'] ?? 0;

				if (($block['type'] ?? '') === 'tool_use') {
					$this->calls[$index] = ['id' => $block['id'] ?? '', 'name' => $block['name'] ?? '', 'json' => ''];
				}
				elseif (($block['type'] ?? '') === 'thinking') {
					$this->thinking[$index] = ['type' => 'thinking', 'thinking' => '', 'signature' => ''];
				}
				elseif (($block['type'] ?? '') === 'redacted_thinking') {
					$this->thinking[$index] = $block;
				}
				break;

			case 'content_block_delta':
				$delta = $event['delta'] ?? [];
				$index = $event['index'] ?? 0;

				switch ($delta['type'] ?? '') {
					case 'text_delta':
						$this->text .= $delta['text'];
						($this->emit)('text', $delta['text']);
						break;

					case 'input_json_delta':
						$this->calls[$index]['json'] .= $delta['partial_json'] ?? '';
						break;

					case 'thinking_delta':
						$this->thinking[$index]['thinking'] .= $delta['thinking'];
						($this->emit)('reasoning', $delta['thinking']);
						break;

					case 'signature_delta':
						$this->thinking[$index]['signature'] = $delta['signature'];
						break;
				}
				break;

			case 'message_delta':
				$this->usage['output'] = (int) ($event['usage']['output_tokens'] ?? $this->usage['output']);
				$this->stop = (string) ($event['delta']['stop_reason'] ?? $this->stop);
				break;

			case 'error':
				throw new RuntimeException((string) ($event['error']['message'] ?? 'Provider error'));
		}
	}
}
