'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseVdf, writeVdf, mergeLaunchOptions, hasNeededFlags, cs2AppNode } = require('../lib/steamConfig');

const SAMPLE = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"730"
					{
						"LastPlayed"		"1795000000"
						"LaunchOptions"		"-novid +fps_max 0"
					}
					"440"
					{
						"LastPlayed"		"1"
					}
				}
				"path"		"C:\\\\Program Files"
			}
		}
	}
	"friends" { "x" "y" } // comment
}
`;

test('vdf: round-trips and edits CS2 launch options only', () => {
  const root = parseVdf(SAMPLE);
  const node = cs2AppNode(root, false);
  assert.equal(node.LaunchOptions, '-novid +fps_max 0');
  node.LaunchOptions = mergeLaunchOptions(node.LaunchOptions);
  const out = writeVdf(root);
  const again = parseVdf(out);
  assert.equal(cs2AppNode(again).LaunchOptions, '-novid +fps_max 0 -condebug -netconport 2121');
  assert.equal(again.UserLocalConfigStore.Software.Valve.Steam.apps['440'].LastPlayed, '1');
  assert.equal(again.UserLocalConfigStore.Software.Valve.Steam.path, 'C:\\\\Program Files');
  assert.equal(again.UserLocalConfigStore.friends.x, 'y');
  assert.ok(out.indexOf('"Software"') < out.indexOf('"friends"'), 'key order kept');
});

test('vdf: creates CS2 node when missing', () => {
  const root = parseVdf('"UserLocalConfigStore"\n{\n}\n');
  cs2AppNode(root, true).LaunchOptions = mergeLaunchOptions('');
  assert.equal(cs2AppNode(parseVdf(writeVdf(root))).LaunchOptions, '-condebug -netconport 2121');
});

test('launch options: no duplicates, detects existing', () => {
  assert.equal(mergeLaunchOptions('-condebug -netconport 2121'), '-condebug -netconport 2121');
  assert.equal(mergeLaunchOptions('-netconport 3000'), '-netconport 3000 -condebug');
  assert.ok(hasNeededFlags('-novid -condebug -netconport 2121'));
  assert.ok(!hasNeededFlags('-novid'));
});
